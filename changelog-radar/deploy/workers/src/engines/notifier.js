/**
 * Notification dispatch engine.
 * Sends alerts via webhook, Slack, email, and in-app channels.
 */
import { hmacSign } from '../utils/crypto.js';
import { CONFIG } from '../config.js';

/**
 * Main cron entry: process unnotified diffs.
 */
export async function runNotifier(env) {
  const results = { processed: 0, sent: 0, errors: 0 };

  // Find diffs that haven't been notified
  const unsentDiffs = await env.DB.prepare(
    `SELECT d.*, s.name as source_name, s.url as source_url, s.user_id
     FROM diffs d JOIN sources s ON s.id = d.source_id
     WHERE d.notify_sent = 0
     ORDER BY d.detected_at ASC LIMIT 50`
  ).all();

  for (const diff of unsentDiffs.results) {
    results.processed++;

    // Find matching alerts for this diff's source/user
    const alerts = await env.DB.prepare(
      `SELECT * FROM alerts
       WHERE user_id = ? AND enabled = 1
         AND (source_id IS NULL OR source_id = ?)
       ORDER BY channel ASC`
    ).bind(diff.user_id, diff.source_id).all();

    let allSent = true;
    for (const alert of alerts.results) {
      try {
        const result = await sendNotification(alert, diff, diff.source_name, env);

        await env.DB.prepare(
          `INSERT INTO alert_log (alert_id, diff_id, channel, status, error_message, attempts)
           VALUES (?, ?, ?, ?, ?, 1)`
        ).bind(alert.id, diff.id, alert.channel, result.success ? 'sent' : 'failed', result.error || null).run();

        if (result.success) {
          results.sent++;
          await env.DB.prepare(
            'UPDATE alerts SET last_triggered_at = datetime(\'now\') WHERE id = ?'
          ).bind(alert.id).run();
        } else {
          allSent = false;
          results.errors++;
        }
      } catch (err) {
        allSent = false;
        results.errors++;
        console.error(`Notification error for alert ${alert.id}: ${err.message}`);
      }
    }

    // Mark diff as notified (even if some alerts failed — retries handle failures)
    if (alerts.results.length === 0 || allSent) {
      await env.DB.prepare(
        'UPDATE diffs SET notify_sent = 1 WHERE id = ?'
      ).bind(diff.id).run();
    }
  }

  // Retry failed deliveries
  await retryFailed(env);

  console.log(`Notifier complete: ${results.processed} diffs, ${results.sent} sent, ${results.errors} errors`);
  return results;
}

/**
 * Send a single notification.
 */
export async function sendNotification(alert, diff, sourceName, env) {
  switch (alert.channel) {
    case 'webhook':
      return await sendWebhook(alert, diff, sourceName, env);
    case 'slack':
      return await sendSlack(alert, diff, sourceName);
    case 'email':
      return await sendEmail(alert, diff, sourceName, env);
    case 'in_app':
      return { success: true }; // In-app alerts are just stored in alert_log
    default:
      return { success: false, error: `Unknown channel: ${alert.channel}` };
  }
}

/**
 * Send webhook notification with HMAC signature.
 */
async function sendWebhook(alert, diff, sourceName, env) {
  const payload = JSON.stringify({
    event: 'changelog.change_detected',
    source: { id: diff.source_id, name: sourceName },
    diff: {
      id: diff.id,
      severity: diff.severity,
      added_lines: diff.added_lines,
      removed_lines: diff.removed_lines,
      summary: diff.summary_text,
      detected_at: diff.detected_at,
    },
    timestamp: new Date().toISOString(),
  });

  const signingKey = env.WEBHOOK_SIGNING_KEY || 'webhook-secret';
  const signature = await hmacSign(payload, signingKey);

  try {
    const response = await fetch(alert.target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ACR-Signature': `sha256=${signature}`,
        'X-ACR-Event': 'changelog.change_detected',
        'User-Agent': 'APIChangelogRadar-Webhook/1.0',
      },
      body: payload,
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Send Slack notification via incoming webhook.
 */
async function sendSlack(alert, diff, sourceName) {
  const severityEmoji = { breaking: '🔴', warning: '🟡', info: '🟢' };
  const emoji = severityEmoji[diff.severity] || '📋';

  const payload = {
    text: `${emoji} ${diff.summary_text || 'Change detected'}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${emoji} API Change Detected`, emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Source:*\n${sourceName}` },
          { type: 'mrkdwn', text: `*Severity:*\n${diff.severity.toUpperCase()}` },
          { type: 'mrkdwn', text: `*Lines Added:*\n+${diff.added_lines}` },
          { type: 'mrkdwn', text: `*Lines Removed:*\n-${diff.removed_lines}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: diff.summary_text || 'A change was detected in the monitored source.' },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `Detected at ${diff.detected_at} | API Changelog Radar` },
        ],
      },
    ],
  };

  try {
    const response = await fetch(alert.target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { success: false, error: `Slack webhook returned ${response.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Send email notification via Resend or SendGrid.
 */
async function sendEmail(alert, diff, sourceName, env) {
  const emailApiKey = env.EMAIL_API_KEY;
  const emailFrom = env.EMAIL_FROM || 'alerts@api-changelog-radar.com';

  if (!emailApiKey) {
    return { success: false, error: 'Email API key not configured' };
  }

  const severityLabel = { breaking: '🔴 BREAKING', warning: '🟡 WARNING', info: '🟢 UPDATE' };
  const subject = `[${severityLabel[diff.severity] || 'UPDATE'}] ${sourceName} — API change detected`;

  const html = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#6d5efc;">API Changelog Radar</h2>
      <div style="background:#f4f5f7;border-radius:12px;padding:20px;margin:16px 0;">
        <h3 style="margin:0 0 8px;">${sourceName}</h3>
        <p style="margin:4px 0;"><strong>Severity:</strong> ${diff.severity.toUpperCase()}</p>
        <p style="margin:4px 0;"><strong>Changes:</strong> +${diff.added_lines} added, -${diff.removed_lines} removed</p>
        <p style="margin:4px 0;"><strong>Detected:</strong> ${diff.detected_at}</p>
      </div>
      <p>${diff.summary_text || 'A change was detected.'}</p>
      <hr style="border:1px solid #e5e7eb;margin:20px 0;">
      <p style="font-size:12px;color:#6b7280;">API Changelog Radar — Monitor vendor changelogs, diff changes, alert teams.</p>
    </div>
  `;

  try {
    // Try Resend API first
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${emailApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [alert.target],
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Email send failed: ${error}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Retry failed alert deliveries.
 */
async function retryFailed(env) {
  const failedLogs = await env.DB.prepare(
    `SELECT al.*, a.channel, a.target, a.config_json,
            d.source_id, d.added_lines, d.removed_lines, d.severity, d.summary_text, d.detected_at,
            s.name as source_name
     FROM alert_log al
     JOIN alerts a ON a.id = al.alert_id
     JOIN diffs d ON d.id = al.diff_id
     JOIN sources s ON s.id = d.source_id
     WHERE al.status = 'failed' AND al.attempts < ?
     ORDER BY al.sent_at ASC LIMIT 20`
  ).bind(CONFIG.alerts.maxRetries).all();

  for (const log of failedLogs.results) {
    const alert = { id: log.alert_id, channel: log.channel, target: log.target, config_json: log.config_json };
    const diff = {
      id: log.diff_id, source_id: log.source_id,
      added_lines: log.added_lines, removed_lines: log.removed_lines,
      severity: log.severity, summary_text: log.summary_text, detected_at: log.detected_at,
    };

    const result = await sendNotification(alert, diff, log.source_name, env);

    await env.DB.prepare(
      'UPDATE alert_log SET status = ?, attempts = attempts + 1, error_message = ? WHERE id = ?'
    ).bind(result.success ? 'sent' : (log.attempts + 1 >= CONFIG.alerts.maxRetries ? 'failed' : 'retried'),
           result.error || null, log.id).run();
  }
}
