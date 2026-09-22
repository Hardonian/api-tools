/**
 * Cryptographic utilities — all using Web Crypto API (zero dependencies).
 * Works natively in Cloudflare Workers.
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const API_KEY_BYTES = 32;
const JWT_ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };

// ── Encoding helpers ───────────────────────────────────────────────────

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes.buffer;
}

function bufToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuf(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── Password Hashing (PBKDF2) ─────────────────────────────────────────

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, KEY_BYTES * 8
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${bufToHex(salt)}:${bufToHex(derived)}`;
}

export async function verifyPassword(password, stored) {
  const [, iterStr, saltHex, hashHex] = stored.split(':');
  const iterations = parseInt(iterStr, 10);
  const salt = new Uint8Array(hexToBuf(saltHex));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, KEY_BYTES * 8
  );
  return timingSafeEqual(bufToHex(derived), hashHex);
}

// ── JWT (HMAC-SHA256) ──────────────────────────────────────────────────

async function getJwtKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), JWT_ALGORITHM, false, ['sign', 'verify']
  );
}

export async function signJwt(payload, secret, expiresInSeconds = 86400) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + expiresInSeconds };

  const headerB64 = bufToBase64url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = bufToBase64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getJwtKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${bufToBase64url(sig)}`;
}

export async function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getJwtKey(secret);
  const sigBuf = base64urlToBuf(sigB64);
  const valid = await crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(signingInput));
  if (!valid) return null;

  const payload = JSON.parse(new TextDecoder().decode(base64urlToBuf(payloadB64)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ── API Key Generation ─────────────────────────────────────────────────

export function generateApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(API_KEY_BYTES));
  const key = `acr_${bufToHex(bytes)}`;
  const prefix = key.substring(0, 12); // 'acr_' + 8 hex chars
  return { key, prefix };
}

export async function hashApiKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return bufToHex(digest);
}

// ── Content Hashing ────────────────────────────────────────────────────

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bufToHex(digest);
}

// ── HMAC Signing (for webhook payloads) ────────────────────────────────

export async function hmacSign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), JWT_ALGORITHM, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return bufToHex(sig);
}

// ── Constant-time comparison ───────────────────────────────────────────

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ── Request ID ─────────────────────────────────────────────────────────

export function generateRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bufToHex(bytes);
}
