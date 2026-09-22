/**
 * Input validation utilities.
 * All validators return { valid: boolean, error?: string }.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/i;
const MAX_NAME_LENGTH = 200;
const MAX_URL_LENGTH = 2048;
const MAX_BODY_SIZE = 1_048_576; // 1 MB

export function validateEmail(email) {
  if (!email || typeof email !== 'string') return { valid: false, error: 'Email is required' };
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length > 254) return { valid: false, error: 'Email is too long' };
  if (!EMAIL_RE.test(trimmed)) return { valid: false, error: 'Invalid email format' };
  return { valid: true, value: trimmed };
}

export function validateUrl(url, requireHttps = false) {
  if (!url || typeof url !== 'string') return { valid: false, error: 'URL is required' };
  const trimmed = url.trim();
  if (trimmed.length > MAX_URL_LENGTH) return { valid: false, error: 'URL is too long' };
  if (!URL_RE.test(trimmed)) return { valid: false, error: 'Invalid URL format (must start with http:// or https://)' };
  if (requireHttps && !trimmed.startsWith('https://')) return { valid: false, error: 'URL must use HTTPS' };
  try { new URL(trimmed); } catch { return { valid: false, error: 'Malformed URL' }; }
  return { valid: true, value: trimmed };
}

export function validateString(value, field, { min = 1, max = MAX_NAME_LENGTH } = {}) {
  if (!value || typeof value !== 'string') return { valid: false, error: `${field} is required` };
  const trimmed = value.trim();
  if (trimmed.length < min) return { valid: false, error: `${field} must be at least ${min} characters` };
  if (trimmed.length > max) return { valid: false, error: `${field} must be at most ${max} characters` };
  return { valid: true, value: trimmed };
}

export function validateEnum(value, field, allowed) {
  if (!value || typeof value !== 'string') return { valid: false, error: `${field} is required` };
  const trimmed = value.trim().toLowerCase();
  if (!allowed.includes(trimmed)) return { valid: false, error: `${field} must be one of: ${allowed.join(', ')}` };
  return { valid: true, value: trimmed };
}

export function validatePassword(password) {
  if (!password || typeof password !== 'string') return { valid: false, error: 'Password is required' };
  if (password.length < 8) return { valid: false, error: 'Password must be at least 8 characters' };
  if (password.length > 128) return { valid: false, error: 'Password is too long' };
  return { valid: true, value: password };
}

export function validateInt(value, field, { min = 0, max = 2147483647 } = {}) {
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  if (!Number.isInteger(n)) return { valid: false, error: `${field} must be an integer` };
  if (n < min || n > max) return { valid: false, error: `${field} must be between ${min} and ${max}` };
  return { valid: true, value: n };
}

/**
 * Parse and validate JSON request body with size limit.
 */
export async function parseBody(request, maxSize = MAX_BODY_SIZE) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return { valid: false, error: 'Content-Type must be application/json' };
  }
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > maxSize) {
    return { valid: false, error: `Request body too large (max ${Math.round(maxSize / 1024)}KB)` };
  }
  try {
    const text = await request.text();
    if (text.length > maxSize) return { valid: false, error: 'Request body too large' };
    const body = JSON.parse(text);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { valid: false, error: 'Request body must be a JSON object' };
    }
    return { valid: true, value: body };
  } catch {
    return { valid: false, error: 'Invalid JSON in request body' };
  }
}

/**
 * Run multiple validators and return first error or all clean values.
 * validators: Array of { field, result } where result is a validation result.
 */
export function validateAll(validators) {
  const values = {};
  for (const { field, result } of validators) {
    if (!result.valid) return { valid: false, error: result.error, field };
    values[field] = result.value;
  }
  return { valid: true, values };
}
