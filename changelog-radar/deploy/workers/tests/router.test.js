/**
 * Router tests.
 */
import { describe, it, expect } from 'vitest';
import { Router } from '../src/router.js';

describe('Router', () => {
  it('matches exact paths', () => {
    const r = new Router();
    r.get('/health', () => 'health');
    const match = r.match('GET', '/health');
    expect(match).toBeTruthy();
    expect(match.params).toEqual({});
  });

  it('matches paths with parameters', () => {
    const r = new Router();
    r.get('/api/v1/sources/:id', () => 'source');
    const match = r.match('GET', '/api/v1/sources/42');
    expect(match).toBeTruthy();
    expect(match.params.id).toBe('42');
  });

  it('matches paths with multiple parameters', () => {
    const r = new Router();
    r.get('/api/v1/sources/:sourceId/diffs/:diffId', () => 'diff');
    const match = r.match('GET', '/api/v1/sources/5/diffs/12');
    expect(match).toBeTruthy();
    expect(match.params.sourceId).toBe('5');
    expect(match.params.diffId).toBe('12');
  });

  it('returns null for unmatched paths', () => {
    const r = new Router();
    r.get('/health', () => 'health');
    expect(r.match('GET', '/nonexistent')).toBeNull();
  });

  it('respects HTTP methods', () => {
    const r = new Router();
    r.post('/api/v1/sources', () => 'create');
    r.get('/api/v1/sources', () => 'list');
    expect(r.match('POST', '/api/v1/sources')).toBeTruthy();
    expect(r.match('GET', '/api/v1/sources')).toBeTruthy();
    expect(r.match('DELETE', '/api/v1/sources')).toBeNull();
  });

  it('handles method helpers', () => {
    const r = new Router();
    r.get('/a', () => {});
    r.post('/b', () => {});
    r.put('/c', () => {});
    r.delete('/d', () => {});
    expect(r.match('GET', '/a')).toBeTruthy();
    expect(r.match('POST', '/b')).toBeTruthy();
    expect(r.match('PUT', '/c')).toBeTruthy();
    expect(r.match('DELETE', '/d')).toBeTruthy();
  });

  it('does not partially match', () => {
    const r = new Router();
    r.get('/health', () => 'health');
    expect(r.match('GET', '/health/extra')).toBeNull();
    expect(r.match('GET', '/heal')).toBeNull();
  });
});
