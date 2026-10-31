import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MOCK_ORIGIN, wasIssuedByMock } from './mockp1.js';

// Every PingOne call is recorded as a trace step and shown raw, for teaching. Redaction happens here, on the
// server, before anything reaches the page:
// - SECRET values (codes, verifiers, client secrets, refresh tokens, device codes, auth_req_id, passwords, cookies,
//   flow ids) are replaced by a fixed marker that keeps only kind and length.
// - TOKENS (access, id, subject and actor tokens, the token sent to introspection or revocation, and a signed request
//   object) are shown masked (first 6 + last 4 characters, length, kind) next to their decoded claims. Exception
//   (owner, 2026-10-31, rule 4): a token the in-process MOCK PingOne issued is fake, so it is shown whole and labelled
//   mock. A live token is never shown whole: whatever its claims say, and even when the live lab is pointed at a fake.
// Identifiers that are not secret (client_id, redirect_uri, scope, authorization_details) are shown as sent.

export const SECRET_KEYS = new Set([
  'code', 'code_verifier', 'client_secret', 'refresh_token', 'device_code', 'auth_req_id',
  'password', 'cookie', 'set-cookie', 'authorization', 'client_assertion', 'flow_id', 'flowid', 'id_token_hint',
]);
export const TOKEN_KEYS = new Set(['access_token', 'id_token', 'subject_token', 'actor_token', 'issued_token', 'token', 'request']);
// Random per-run values that are not secret, but long and noisy.
const SHORTEN_KEYS = new Set(['state', 'nonce', 'code_challenge', 'jti']);

// Whether the request being served is in MOCK mode. The app sets it per request; outside a request it is false, so a
// token is masked unless the lab is in mock mode AND its in-process mock issued the token.
export const traceContext = new AsyncLocalStorage();
const rawMockTokens = (value) => traceContext.getStore()?.mock === true && wasIssuedByMock(value);

const kindOf = (text) => (text.split('.').length === 3 ? 'JWT' : 'opaque');

export function redacted(value) {
  const text = String(value);
  return `<redacted ${kindOf(text)}, ${text.length} chars>`;
}

// A token reduced to something that cannot be replayed: its edges, its length and its kind.
export function masked(value) {
  const text = String(value);
  if (text.length <= 16) return { masked: '<too short to mask>', length: text.length, kind: kindOf(text) };
  return { masked: `${text.slice(0, 6)}...${text.slice(-4)}`, length: text.length, kind: kindOf(text) };
}

export function shortened(value) {
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 8)}...` : text;
}

function maskedRequestUri(value) {
  const text = String(value);
  const at = text.lastIndexOf(':');
  return at > 0 ? `${text.slice(0, at + 1)}${shortened(text.slice(at + 1))}` : shortened(text);
}

export function safeValue(key, value) {
  if (value === undefined || value === null) return value;
  const k = String(key).toLowerCase();
  if (SECRET_KEYS.has(k)) return redacted(value);
  if (TOKEN_KEYS.has(k)) return rawMockTokens(value) ? String(value) : masked(value);
  if (SHORTEN_KEYS.has(k)) return shortened(value);
  if (k === 'request_uri') return maskedRequestUri(value);
  return value;
}

const MAX_DEPTH = 6;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

// Walks plain JSON (iteratively bounded by depth) and redacts by key. Anything deeper than MAX_DEPTH is dropped.
export function safeBody(body, depth = 0) {
  if (body === null || typeof body !== 'object') return body;
  if (depth >= MAX_DEPTH) return '<nested too deep>';
  if (Array.isArray(body)) return body.slice(0, 50).map((item) => safeBody(item, depth + 1));
  const out = {};
  // An error object's code (INVALID_TOKEN, VALIDATION_ERROR) is a label, not an authorization code: shown as is.
  const isError = Object.hasOwn(body, 'message') || Object.hasOwn(body, 'details');
  for (const [key, value] of Object.entries(body)) {
    if (isError && key === 'code' && typeof value === 'string' && ERROR_CODE.test(value)) { out[key] = value; continue; }
    if (value !== null && typeof value === 'object') {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? redacted(JSON.stringify(value)) : safeBody(value, depth + 1);
    } else out[key] = safeValue(key, value);
  }
  return out;
}

// URLSearchParams or plain object; authorization_details is shown parsed. A `token` sent to introspection or
// revocation is masked like any token, except a refresh token (token_type_hint), which is a secret.
export function safeParams(params) {
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params || {});
  const refresh = entries.some(([k, v]) => k === 'token_type_hint' && v === 'refresh_token');
  const out = {};
  for (const [key, value] of entries) {
    if (key === 'token' && refresh) out[key] = redacted(value);
    else if (key === 'authorization_details') {
      try { out[key] = JSON.parse(value); } catch { out[key] = String(value).slice(0, 200); }
    } else out[key] = safeValue(key, value);
  }
  return out;
}

export function safeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const k = key.toLowerCase();
    if (k === 'authorization') out[key] = `${String(value).split(' ')[0]} <redacted>`;
    else if (k === 'cookie') out[key] = '<redacted PingOne session cookies>';
    else out[key] = safeValue(k, value);
  }
  return out;
}

// The URL without its query (parameters are shown separately, redacted).
export function bareUrl(value) {
  try {
    const url = new URL(value);
    // Decoded for reading, so a masked segment shows as <flow id> rather than %3Cflow%20id%3E.
    let path = url.pathname;
    try { path = decodeURI(path); } catch { /* keep it encoded */ }
    return `${url.origin}${path}`;
  } catch { return String(value).split('?')[0]; }
}

function decodePart(part) {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// Decoded claims of a JWT (no signature check here), or null for an opaque token.
export function claimsOf(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  return parts.length === 3 ? decodePart(parts[1]) : null;
}

export function headerOf(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  return parts.length === 3 ? decodePart(parts[0]) : null;
}

// What the page may show about a token: masked value, header, claims.
// A token the mock PingOne signed (its issuer is the mock's .invalid host) says so: mock: true.
export function tokenView(token) {
  if (typeof token !== 'string' || !token) return null;
  const claims = claimsOf(token);
  const mock = rawMockTokens(token) && typeof claims?.iss === 'string' && claims.iss.startsWith(`${MOCK_ORIGIN}/`);
  // A mock token is fake: shown whole (value) and labelled. Every other token is masked.
  if (mock) return { value: token, length: token.length, kind: kindOf(token), header: headerOf(token), claims, mock: true };
  return { ...masked(token), header: headerOf(token), claims };
}

// W3C trace context: one trace id per card run, a new span id per hop.
export function newTraceId() { return crypto.randomBytes(16).toString('hex'); }
export function traceparent(traceId = newTraceId()) {
  return `00-${traceId}-${crypto.randomBytes(8).toString('hex')}-01`;
}

export function step({ id, title, request = null, response = null, claims = null, note = null }) {
  return { id, title, request, response, claims, note };
}
