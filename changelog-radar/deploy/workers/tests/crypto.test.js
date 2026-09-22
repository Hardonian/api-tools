/**
 * Crypto utilities tests.
 */
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, signJwt, verifyJwt, generateApiKey, hashApiKey, sha256, generateRequestId } from '../src/utils/crypto.js';

describe('Password Hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('MySecurePassword123');
    expect(hash).toMatch(/^pbkdf2:\d+:[a-f0-9]+:[a-f0-9]+$/);
    expect(await verifyPassword('MySecurePassword123', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('CorrectPassword');
    expect(await verifyPassword('WrongPassword', hash)).toBe(false);
  });

  it('generates different hashes for same password (random salt)', async () => {
    const hash1 = await hashPassword('SamePassword');
    const hash2 = await hashPassword('SamePassword');
    expect(hash1).not.toBe(hash2);
  });
});

describe('JWT', () => {
  const secret = 'test-secret-key';

  it('signs and verifies a token', async () => {
    const token = await signJwt({ sub: 42, email: 'test@test.com' }, secret);
    expect(token.split('.')).toHaveLength(3);

    const payload = await verifyJwt(token, secret);
    expect(payload).toBeTruthy();
    expect(payload.sub).toBe(42);
    expect(payload.email).toBe('test@test.com');
  });

  it('rejects token with wrong secret', async () => {
    const token = await signJwt({ sub: 1 }, 'key-a');
    const payload = await verifyJwt(token, 'key-b');
    expect(payload).toBeNull();
  });

  it('rejects expired token', async () => {
    const token = await signJwt({ sub: 1 }, secret, -1); // expired 1 second ago
    const payload = await verifyJwt(token, secret);
    expect(payload).toBeNull();
  });

  it('rejects malformed token', async () => {
    expect(await verifyJwt('not.a.real.token.here', secret)).toBeNull();
    expect(await verifyJwt('', secret)).toBeNull();
    expect(await verifyJwt('single', secret)).toBeNull();
  });
});

describe('API Key', () => {
  it('generates a key with prefix', () => {
    const { key, prefix } = generateApiKey();
    expect(key).toMatch(/^acr_[a-f0-9]{64}$/);
    expect(prefix).toMatch(/^acr_[a-f0-9]{8}$/);
    expect(key.startsWith(prefix)).toBe(true);
  });

  it('hashes a key deterministically', async () => {
    const hash1 = await hashApiKey('acr_test123');
    const hash2 = await hashApiKey('acr_test123');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces unique keys', () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    expect(k1.key).not.toBe(k2.key);
  });
});

describe('SHA-256', () => {
  it('hashes content', async () => {
    const hash = await sha256('Hello, World!');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces consistent hashes', async () => {
    const h1 = await sha256('test');
    const h2 = await sha256('test');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different content', async () => {
    const h1 = await sha256('aaa');
    const h2 = await sha256('bbb');
    expect(h1).not.toBe(h2);
  });
});

describe('Request ID', () => {
  it('generates a hex string', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, generateRequestId));
    expect(ids.size).toBe(100);
  });
});
