/**
 * Validation utilities tests.
 */
import { describe, it, expect } from 'vitest';
import { validateEmail, validateUrl, validateString, validateEnum, validatePassword, validateInt, validateAll } from '../src/utils/validate.js';

describe('validateEmail', () => {
  it('accepts valid emails', () => {
    expect(validateEmail('user@example.com').valid).toBe(true);
    expect(validateEmail('test.user+tag@domain.co.uk').valid).toBe(true);
  });

  it('normalizes to lowercase', () => {
    expect(validateEmail('User@EXAMPLE.COM').value).toBe('user@example.com');
  });

  it('rejects invalid emails', () => {
    expect(validateEmail('').valid).toBe(false);
    expect(validateEmail('not-an-email').valid).toBe(false);
    expect(validateEmail('@domain.com').valid).toBe(false);
    expect(validateEmail('user@').valid).toBe(false);
    expect(validateEmail(null).valid).toBe(false);
  });
});

describe('validateUrl', () => {
  it('accepts valid URLs', () => {
    expect(validateUrl('https://example.com').valid).toBe(true);
    expect(validateUrl('http://localhost:3000/path').valid).toBe(true);
    expect(validateUrl('https://api.stripe.com/v1/docs?page=1').valid).toBe(true);
  });

  it('rejects invalid URLs', () => {
    expect(validateUrl('').valid).toBe(false);
    expect(validateUrl('not-a-url').valid).toBe(false);
    expect(validateUrl('ftp://files.com').valid).toBe(false);
  });

  it('enforces HTTPS when required', () => {
    expect(validateUrl('http://example.com', true).valid).toBe(false);
    expect(validateUrl('https://example.com', true).valid).toBe(true);
  });
});

describe('validateString', () => {
  it('accepts valid strings', () => {
    expect(validateString('Hello', 'Name').valid).toBe(true);
    expect(validateString('  trimmed  ', 'Name').value).toBe('trimmed');
  });

  it('enforces length limits', () => {
    expect(validateString('', 'Name').valid).toBe(false);
    expect(validateString('ab', 'Name', { min: 3 }).valid).toBe(false);
    expect(validateString('a'.repeat(201), 'Name').valid).toBe(false);
  });
});

describe('validateEnum', () => {
  it('accepts valid enum values', () => {
    expect(validateEnum('changelog', 'Kind', ['changelog', 'spec']).valid).toBe(true);
  });

  it('normalizes to lowercase', () => {
    expect(validateEnum('CHANGELOG', 'Kind', ['changelog']).value).toBe('changelog');
  });

  it('rejects invalid values', () => {
    expect(validateEnum('invalid', 'Kind', ['changelog', 'spec']).valid).toBe(false);
  });
});

describe('validatePassword', () => {
  it('accepts valid passwords', () => {
    expect(validatePassword('password123').valid).toBe(true);
    expect(validatePassword('12345678').valid).toBe(true);
  });

  it('rejects short passwords', () => {
    expect(validatePassword('1234567').valid).toBe(false);
    expect(validatePassword('').valid).toBe(false);
  });

  it('rejects long passwords', () => {
    expect(validatePassword('a'.repeat(129)).valid).toBe(false);
  });
});

describe('validateInt', () => {
  it('accepts valid integers', () => {
    expect(validateInt(42, 'Count').valid).toBe(true);
    expect(validateInt('100', 'Count').value).toBe(100);
  });

  it('enforces range', () => {
    expect(validateInt(-1, 'Count', { min: 0 }).valid).toBe(false);
    expect(validateInt(200, 'Count', { max: 100 }).valid).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(validateInt('abc', 'Count').valid).toBe(false);
    expect(validateInt(3.14, 'Count').valid).toBe(false);
  });
});

describe('validateAll', () => {
  it('returns all values when valid', () => {
    const result = validateAll([
      { field: 'email', result: { valid: true, value: 'a@b.com' } },
      { field: 'name', result: { valid: true, value: 'Test' } },
    ]);
    expect(result.valid).toBe(true);
    expect(result.values.email).toBe('a@b.com');
    expect(result.values.name).toBe('Test');
  });

  it('returns first error', () => {
    const result = validateAll([
      { field: 'email', result: { valid: true, value: 'a@b.com' } },
      { field: 'name', result: { valid: false, error: 'Name is required' } },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Name is required');
    expect(result.field).toBe('name');
  });
});
