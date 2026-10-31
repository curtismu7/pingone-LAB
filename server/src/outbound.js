import { traceparent as newTraceparent } from './trace.js';

// The one door out of this app. Every outbound request goes through call(), and call() only ever reaches the
// configured PingOne environment: https, the auth host of its region, and only paths under /<environment id>/,
// without following redirects, with a timeout and a body size cap. Anything else is refused before a socket is
// opened. No other module may call fetch. Live mode (owner decision 2026-10-31, rules section 3): outbound only to
// the configured PingOne environment. Mock mode: every call goes to the in-process mock (mockFetch), never to the
// network; the real fetch sits behind the netguard, which refuses anything in mock mode.

export const TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 256 * 1024;

export class OutboundRefused extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

// The environment's base URL (https://auth.pingone.<tld>/<env>), or a refusal saying why there is none.
export function allowedBase(authBase) {
  if (!authBase) throw new OutboundRefused('not_configured', 'No PingOne environment is configured');
  let url;
  try { url = new URL(authBase); } catch { throw new OutboundRefused('bad_base', 'The PingOne environment URL is not a URL'); }
  if (url.protocol !== 'https:') throw new OutboundRefused('not_https', 'PingOne must be https');
  if (url.username || url.password) throw new OutboundRefused('credentials_in_url', 'The PingOne URL must not carry credentials');
  return { origin: url.origin, prefix: `${url.pathname.replace(/\/+$/, '')}/` };
}

export function assertAllowed(target, authBase) {
  const { origin, prefix } = allowedBase(authBase);
  let url;
  try { url = new URL(target); } catch { throw new OutboundRefused('bad_url', 'Not a URL'); }
  if (url.protocol !== 'https:') throw new OutboundRefused('not_https', 'Outbound calls are https only');
  if (url.username || url.password) throw new OutboundRefused('credentials_in_url', 'Outbound URLs must not carry credentials');
  if (url.origin !== origin) throw new OutboundRefused('other_origin', 'Outbound calls may only reach the configured PingOne environment');
  // Normalised by URL(): /env/../other cannot slip past the prefix.
  if (!url.pathname.startsWith(prefix)) throw new OutboundRefused('other_environment', 'Outbound calls may only reach the configured PingOne environment');
  return url;
}

async function readCapped(response, max) {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > max) {
      chunks.push(value.subarray(0, max - total));
      await reader.cancel().catch(() => {});
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: true };
    }
    chunks.push(value);
    total += value.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

export function createOutbound({ getAuthBase, fetchImpl = globalThis.fetch, mockFetch = null, isMock = () => false, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BODY_BYTES }) {
  // { url, method, headers, body, traceId } -> { status, ok, headers, text, json, truncated, setCookies, location, traceparent }
  async function call(target, { method = 'GET', headers = {}, body, traceId } = {}) {
    const url = assertAllowed(target, getAuthBase());
    const tp = newTraceparent(traceId);
    const mock = isMock();
    if (mock && !mockFetch) throw new OutboundRefused('netguard', 'Mock mode has no mock PingOne to call');
    let response;
    try {
      response = await (mock ? mockFetch : fetchImpl)(url.toString(), {
        method,
        headers: { ...headers, traceparent: tp },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.reason === 'netguard') throw new OutboundRefused('netguard', error.message);
      throw new OutboundRefused('unreachable', 'PingOne did not answer');
    }
    let text;
    let truncated;
    // A body that times out or resets mid-read is the same refusal as no answer at all.
    try { ({ text, truncated } = await readCapped(response, maxBytes)); } catch {
      throw new OutboundRefused('unreachable', 'PingOne stopped answering mid-reply');
    }
    let json = null;
    if (!truncated && text) { try { json = JSON.parse(text); } catch { json = null; } }
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    // A redirect is reported, never followed. Its target is shown only when it stays on PingOne, and without its
    // query (an authorization code travels there). rawLocation is for the server only (PingOne's /as/resume hands
    // the code back in it) and never goes into a trace.
    let location = null;
    const raw = response.headers.get('location');
    if (raw) {
      try {
        const next = new URL(raw, url);
        location = next.origin === url.origin ? `${next.origin}${next.pathname}` : '<another origin, not followed>';
      } catch { location = '<unparsable, not followed>'; }
    }
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: response.headers,
      text,
      json: json && typeof json === 'object' ? json : null,
      truncated,
      setCookies,
      location,
      rawLocation: raw || null,
      traceparent: tp,
      mock,
    };
  }
  return { call };
}
