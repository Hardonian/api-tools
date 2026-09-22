/**
 * Polling engine — cron-triggered URL fetcher.
 * Fetches content from monitored sources and stores snapshots.
 */
import { sha256 } from '../utils/crypto.js';
import { CONFIG } from '../config.js';

/**
 * Main cron entry: poll all sources that are due.
 */
export async function runPoller(env) {
  const now = new Date();
  const results = { polled: 0, changed: 0, errors: 0 };

  // Find sources due for polling
  const sources = await env.DB.prepare(
    `SELECT * FROM sources
     WHERE status = 'active'
       AND (last_polled_at IS NULL
            OR datetime(last_polled_at, '+' || poll_interval_minutes || ' minutes') <= datetime('now'))
     ORDER BY last_polled_at ASC NULLS FIRST
     LIMIT 50`
  ).all();

  for (const source of sources.results) {
    try {
      const result = await pollSingleSource(source, env);
      results.polled++;
      if (result.changed) results.changed++;
    } catch (err) {
      results.errors++;
      console.error(`Poll error for source ${source.id}: ${err.message}`);
    }
  }

  console.log(`Poller complete: ${results.polled} polled, ${results.changed} changed, ${results.errors} errors`);
  return results;
}

/**
 * Poll a single source — fetch URL, store snapshot, trigger diff if changed.
 */
export async function pollSingleSource(source, env) {
  const startTime = Date.now();
  let content, httpStatus;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.polling.fetchTimeoutMs);

    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': CONFIG.polling.userAgent,
        'Accept': 'text/html, application/json, text/plain, */*',
      },
    });
    clearTimeout(timeout);

    httpStatus = response.status;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const rawContent = await response.text();

    // Enforce size limit
    if (rawContent.length > CONFIG.polling.maxContentBytes) {
      throw new Error(`Response too large: ${rawContent.length} bytes`);
    }

    // Extract content based on kind
    content = extractContent(rawContent, source.kind, source.selector);

  } catch (err) {
    // Track failure
    const failures = source.consecutive_failures + 1;
    const newStatus = failures >= CONFIG.polling.maxConsecutiveFailures ? 'error' : 'active';

    await env.DB.prepare(
      `UPDATE sources SET consecutive_failures = ?, status = ?, last_polled_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).bind(failures, newStatus, source.id).run();

    return { changed: false, error: err.message, status: newStatus };
  }

  const fetchDuration = Date.now() - startTime;
  const contentHash = await sha256(content);
  const lineCount = content.split('\n').length;
  const charCount = content.length;

  // Check if content has changed
  const prevSnapshot = await env.DB.prepare(
    'SELECT id, content_hash FROM snapshots WHERE source_id = ? ORDER BY fetched_at DESC LIMIT 1'
  ).bind(source.id).first();

  const changed = !prevSnapshot || prevSnapshot.content_hash !== contentHash;

  // Store snapshot
  const headline = extractHeadline(content);
  const snapResult = await env.DB.prepare(
    `INSERT INTO snapshots (source_id, content_hash, raw_content, character_count, line_count, headline, http_status, fetch_duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(source.id, contentHash, content, charCount, lineCount, headline, httpStatus, fetchDuration).run();

  // Reset failures and update poll time
  await env.DB.prepare(
    `UPDATE sources SET consecutive_failures = 0, status = 'active', last_polled_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).bind(source.id).run();

  // If changed, trigger diff
  if (changed && prevSnapshot) {
    const { computeDiff } = await import('./differ.js');
    const prevContent = await env.DB.prepare(
      'SELECT raw_content FROM snapshots WHERE id = ?'
    ).bind(prevSnapshot.id).first();

    if (prevContent?.raw_content) {
      await computeDiff(
        source.id,
        prevSnapshot.id,
        snapResult.meta.last_row_id,
        prevContent.raw_content,
        content,
        env
      );
    }
  }

  return { changed, content_hash: contentHash, fetch_duration_ms: fetchDuration };
}

/**
 * Extract relevant content based on source kind.
 */
function extractContent(raw, kind, selector) {
  if (kind === 'spec' || kind === 'webhook') {
    // Try to parse as JSON and re-stringify for consistent comparison
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  }

  if (selector && (kind === 'changelog' || kind === 'custom')) {
    // Basic CSS selector extraction (for Workers without DOM parser)
    // Extract content between matching tags — works for simple selectors like #changelog, .content
    return raw; // Full DOM parsing would require HTMLRewriter; keeping raw for now
  }

  // Strip HTML tags for cleaner diffing on HTML content
  if (raw.includes('<html') || raw.includes('<!DOCTYPE')) {
    return stripHtml(raw);
  }

  return raw;
}

/**
 * Basic HTML tag stripping for cleaner diffs.
 */
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract a headline from the content (first non-empty line).
 */
function extractHeadline(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const headline = lines[0] || '';
  return headline.slice(0, 200);
}
