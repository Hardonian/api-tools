/**
 * Diff computation engine.
 * Line-by-line diff with severity classification.
 */
import { CONFIG } from '../config.js';

/**
 * Compute diff between old and new content, store in diffs table.
 */
export async function computeDiff(sourceId, oldSnapshotId, newSnapshotId, oldContent, newContent, env) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Compute line diff
  const { added, removed, patch, changedSections } = lineDiff(oldLines, newLines);

  // Classify severity
  const severity = classifySeverity(patch, added, removed);

  // Generate summary
  const summary = generateSummary(added, removed, severity, changedSections);

  // Store diff
  const result = await env.DB.prepare(
    `INSERT INTO diffs (source_id, old_snapshot_id, new_snapshot_id, added_lines, removed_lines, changed_sections, diff_patch, summary_text, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    sourceId, oldSnapshotId, newSnapshotId,
    added.length, removed.length,
    JSON.stringify(changedSections),
    patch,
    summary,
    severity
  ).run();

  return {
    id: result.meta.last_row_id,
    added: added.length,
    removed: removed.length,
    severity,
    summary,
  };
}

/**
 * Simple line-by-line diff producing a unified diff patch.
 * Uses a longest common subsequence (LCS) approach.
 */
function lineDiff(oldLines, newLines) {
  const added = [];
  const removed = [];
  const patchLines = [];
  const changedSections = [];

  // Build a set-based diff for efficiency
  const oldSet = new Map();
  oldLines.forEach((line, i) => {
    if (!oldSet.has(line)) oldSet.set(line, []);
    oldSet.get(line).push(i);
  });

  const newSet = new Map();
  newLines.forEach((line, i) => {
    if (!newSet.has(line)) newSet.set(line, []);
    newSet.get(line).push(i);
  });

  // Simple diff: walk through both arrays
  const maxLen = Math.max(oldLines.length, newLines.length);
  let inChange = false;
  let currentSection = '';

  // Use Myers-like approach for small diffs, fallback to simple comparison
  if (oldLines.length + newLines.length < 10000) {
    const lcs = computeLCS(oldLines, newLines);
    let oi = 0, ni = 0, li = 0;

    while (oi < oldLines.length || ni < newLines.length) {
      if (li < lcs.length && oi < oldLines.length && ni < newLines.length
          && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
        // Common line
        patchLines.push(` ${oldLines[oi]}`);
        oi++; ni++; li++;
        if (inChange) { inChange = false; }
      } else if (li < lcs.length && ni < newLines.length && newLines[ni] === lcs[li]) {
        // Line removed from old
        patchLines.push(`-${oldLines[oi]}`);
        removed.push({ line: oi + 1, content: oldLines[oi] });
        if (!inChange) { inChange = true; currentSection = detectSection(oldLines, oi); }
        if (currentSection && !changedSections.includes(currentSection)) changedSections.push(currentSection);
        oi++;
      } else if (li < lcs.length && oi < oldLines.length && oldLines[oi] === lcs[li]) {
        // Line added in new
        patchLines.push(`+${newLines[ni]}`);
        added.push({ line: ni + 1, content: newLines[ni] });
        if (!inChange) { inChange = true; currentSection = detectSection(newLines, ni); }
        if (currentSection && !changedSections.includes(currentSection)) changedSections.push(currentSection);
        ni++;
      } else {
        // Neither matches LCS
        if (oi < oldLines.length) {
          patchLines.push(`-${oldLines[oi]}`);
          removed.push({ line: oi + 1, content: oldLines[oi] });
          oi++;
        }
        if (ni < newLines.length) {
          patchLines.push(`+${newLines[ni]}`);
          added.push({ line: ni + 1, content: newLines[ni] });
          ni++;
        }
        if (!inChange) { inChange = true; }
      }
    }
  } else {
    // Large file fallback: simple line-by-line comparison
    for (let i = 0; i < maxLen; i++) {
      const oldLine = i < oldLines.length ? oldLines[i] : undefined;
      const newLine = i < newLines.length ? newLines[i] : undefined;
      if (oldLine === newLine) {
        patchLines.push(` ${oldLine}`);
      } else {
        if (oldLine !== undefined) {
          patchLines.push(`-${oldLine}`);
          removed.push({ line: i + 1, content: oldLine });
        }
        if (newLine !== undefined) {
          patchLines.push(`+${newLine}`);
          added.push({ line: i + 1, content: newLine });
        }
      }
    }
  }

  // Trim patch to only show changed regions (context of 3 lines)
  const patch = buildUnifiedPatch(patchLines);

  return { added, removed, patch, changedSections };
}

/**
 * Compute Longest Common Subsequence.
 */
function computeLCS(a, b) {
  const m = a.length, n = b.length;

  // For very large arrays, use hash-based approach
  if (m * n > 1_000_000) {
    // Fallback: simple set intersection preserving order
    const bSet = new Set(b);
    return a.filter(line => bSet.has(line));
  }

  // Standard DP LCS
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to find LCS
  const lcs = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return lcs;
}

/**
 * Build unified diff patch showing only changed regions with 3 lines of context.
 */
function buildUnifiedPatch(patchLines) {
  const CONTEXT = 3;
  const hunks = [];
  let hunkStart = -1;
  let lastChange = -1;

  for (let i = 0; i < patchLines.length; i++) {
    if (patchLines[i][0] === '+' || patchLines[i][0] === '-') {
      if (hunkStart === -1) hunkStart = Math.max(0, i - CONTEXT);
      lastChange = i;
    } else if (lastChange >= 0 && i - lastChange > CONTEXT) {
      hunks.push(patchLines.slice(hunkStart, lastChange + CONTEXT + 1).join('\n'));
      hunkStart = -1;
      lastChange = -1;
    }
  }
  if (hunkStart >= 0) {
    hunks.push(patchLines.slice(hunkStart, Math.min(patchLines.length, lastChange + CONTEXT + 1)).join('\n'));
  }

  return hunks.join('\n...\n');
}

/**
 * Classify diff severity based on keywords and magnitude.
 */
function classifySeverity(patch, addedLines, removedLines) {
  const patchLower = patch.toLowerCase();

  // Check for breaking change indicators
  for (const keyword of CONFIG.diff.breakingKeywords) {
    if (patchLower.includes(keyword)) return 'breaking';
  }

  // Check for warning indicators
  for (const keyword of CONFIG.diff.warningKeywords) {
    if (patchLower.includes(keyword)) return 'warning';
  }

  // Large removals are likely breaking
  if (removedLines.length > 20 && removedLines.length > addedLines.length * 2) {
    return 'breaking';
  }

  // Moderate changes are warnings
  if (removedLines.length > 5) return 'warning';

  return 'info';
}

/**
 * Generate a human-readable summary of the diff.
 */
function generateSummary(added, removed, severity, changedSections) {
  const parts = [];

  if (added.length > 0) parts.push(`+${added.length} lines added`);
  if (removed.length > 0) parts.push(`-${removed.length} lines removed`);

  const severityLabel = { breaking: '🔴 Breaking change', warning: '🟡 Notable change', info: '🟢 Update' };
  const label = severityLabel[severity] || 'Update';

  let summary = `${label}: ${parts.join(', ')}`;
  if (changedSections.length > 0) {
    summary += ` in ${changedSections.slice(0, 3).join(', ')}`;
  }

  return summary;
}

/**
 * Detect section heading near a changed line.
 */
function detectSection(lines, lineIndex) {
  // Look backwards for a heading-like line
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 10); i--) {
    const line = lines[i].trim();
    // Markdown heading
    if (line.startsWith('#')) return line.replace(/^#+\s*/, '');
    // HTML heading
    const match = line.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/i);
    if (match) return match[1];
    // ALL CAPS heading
    if (line.length > 3 && line.length < 80 && line === line.toUpperCase() && /[A-Z]/.test(line)) return line;
  }
  return '';
}
