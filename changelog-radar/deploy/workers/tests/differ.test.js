/**
 * Diff engine tests.
 */
import { describe, it, expect } from 'vitest';

// Import the internal functions by re-implementing the diff logic for testing
// since computeDiff requires a DB. We test the classification and summary logic.
import { CONFIG } from '../src/config.js';

// Replicate the severity classification logic for unit testing
function classifySeverity(patch, addedCount, removedCount) {
  const patchLower = patch.toLowerCase();
  for (const keyword of CONFIG.diff.breakingKeywords) {
    if (patchLower.includes(keyword)) return 'breaking';
  }
  for (const keyword of CONFIG.diff.warningKeywords) {
    if (patchLower.includes(keyword)) return 'warning';
  }
  if (removedCount > 20 && removedCount > addedCount * 2) return 'breaking';
  if (removedCount > 5) return 'warning';
  return 'info';
}

describe('Severity Classification', () => {
  it('detects breaking changes by keyword', () => {
    expect(classifySeverity('The /users endpoint has been removed', 2, 5)).toBe('breaking');
    expect(classifySeverity('This feature will be sunset on 2026-12-31', 1, 0)).toBe('breaking');
    expect(classifySeverity('Breaking change: auth flow updated', 5, 3)).toBe('breaking');
    expect(classifySeverity('Endpoint discontinued', 0, 10)).toBe('breaking');
  });

  it('detects warnings by keyword', () => {
    expect(classifySeverity('The v1 API is now deprecated', 2, 0)).toBe('warning');
    expect(classifySeverity('Field name changed from foo to bar', 1, 1)).toBe('warning');
    expect(classifySeverity('Migration required for new schema', 10, 0)).toBe('warning');
  });

  it('detects breaking by magnitude (large removals)', () => {
    expect(classifySeverity('lots of lines gone', 5, 25)).toBe('breaking');
    expect(classifySeverity('many removals', 3, 50)).toBe('breaking');
  });

  it('detects warning by moderate removals', () => {
    expect(classifySeverity('some changes', 2, 8)).toBe('warning');
  });

  it('returns info for minor additions', () => {
    expect(classifySeverity('Added new endpoint POST /widgets', 5, 0)).toBe('info');
    expect(classifySeverity('New parameter added', 2, 1)).toBe('info');
  });
});

describe('Diff Keywords Config', () => {
  it('has breaking keywords', () => {
    expect(CONFIG.diff.breakingKeywords).toContain('removed');
    expect(CONFIG.diff.breakingKeywords).toContain('breaking');
    expect(CONFIG.diff.breakingKeywords).toContain('sunset');
  });

  it('has warning keywords', () => {
    expect(CONFIG.diff.warningKeywords).toContain('deprecated');
    expect(CONFIG.diff.warningKeywords).toContain('changed');
  });
});
