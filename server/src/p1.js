import { verifyIdToken, JwtInvalid } from './jose.js';
import { OutboundRefused } from './outbound.js';
import { ADVERTISED } from './advertised.js';
import { safeBody, safeHeaders, safeParams, bareUrl, claimsOf, step } from './trace.js';

// PingOne as the authorization server: discovery, the JWKS, token-endpoint requests with client authentication,
// bearer calls (userinfo) and ID token checks. Every request goes through the outbound guard and comes back as a
// trace step.

export class LabError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const ENDPOINTS = {
  authorizationEndpoint: 'authorization_endpoint',
  tokenEndpoint: 'token_endpoint',
  jwksUri: 'jwks_uri',
  parEndpoint: 'pushed_authorization_request_endpoint',
  backchannelEndpoint: 'backchannel_authentication_endpoint',
  deviceEndpoint: 'device_authorization_endpoint',
  userinfoEndpoint: 'userinfo_endpoint',
  introspectionEndpoint: 'introspection_endpoint',
  revocationEndpoint: 'revocation_endpoint',
};
const REQUIRED_ENDPOINTS = ['authorizationEndpoint', 'tokenEndpoint', 'jwksUri'];

const basic = (id, secret) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

// A recorded hop: the request as sent (redacted), PingOne's answer (redacted) and the traceparent it carried.
export function hop({ id, title, method, url, headers = {}, params = null, json = null, result, claims = null, note = null }) {
  const s = step({
    id,
    title,
    request: {
      method,
      url: bareUrl(url),
      headers: safeHeaders({ ...headers, traceparent: result?.traceparent }),
      ...(params ? { params: safeParams(params) } : {}),
      ...(json ? { body: safeBody(json) } : {}),
    },
    response: result ? {
      status: result.status,
      ...(result.location ? { location: result.location } : {}),
      body: result.json ? safeBody(result.json) : (result.text ? '<not JSON>' : null),
    } : null,
    claims,
    note,
  });
  // A hop answered by the in-process mock PingOne is labelled so on the page.
  if (result?.mock) s.mock = true;
  return s;
}

function asLabError(error) {
  if (error instanceof LabError) return error;
  if (error instanceof OutboundRefused) {
    return new LabError(`outbound_${error.reason}`, error.message, error.reason === 'not_configured' ? 409 : 502);
  }
  return error;
}

export function createP1({ outbound, settings, now = Date.now }) {
  let cache = null; // { issuer, at, metadata }

  const issuer = () => settings.issuer();

  async function call(url, init) {
    try { return await outbound.call(url, init); } catch (error) { throw asLabError(error); }
  }

  function readMetadata(doc, configured) {
    if (!doc || typeof doc !== 'object') throw new LabError('discovery_invalid', 'Discovery is not JSON');
    if (String(doc.issuer || '').replace(/\/+$/, '') !== configured) {
      throw new LabError('discovery_issuer_mismatch', 'The discovery issuer does not match the configured environment');
    }
    const base = settings.authBase();
    const origin = new URL(base).origin;
    const prefix = `${new URL(base).pathname}/`;
    const metadata = { issuer: doc.issuer, raw: doc };
    for (const [name, field] of Object.entries(ENDPOINTS)) {
      const value = doc[field];
      if (!value) { metadata[name] = ''; continue; }
      let url;
      try { url = new URL(value); } catch { throw new LabError('discovery_invalid', `${field} is not a URL`); }
      if (url.protocol !== 'https:' || url.origin !== origin || !url.pathname.startsWith(prefix)) {
        throw new LabError('discovery_invalid', `${field} is not in the configured PingOne environment`);
      }
      metadata[name] = url.toString();
    }
    for (const name of REQUIRED_ENDPOINTS) {
      if (!metadata[name]) throw new LabError('discovery_invalid', `Discovery has no ${ENDPOINTS[name]}`);
    }
    // PingOne's Authentication API (flows) and resume endpoint live beside /as under the environment.
    metadata.authBase = base;
    return metadata;
  }

  // { metadata, step }. Cached for five minutes per issuer; `fresh` skips the cache. With `need` (a card id), a
  // PingOne that does not advertise what the card needs is refused here, before the card calls anything else.
  async function discover({ traceId, fresh = false, need = null } = {}) {
    const found = await read({ traceId, fresh });
    const check = need ? ADVERTISED[need] : null;
    if (check && !check(found.metadata.raw, found.metadata)) {
      throw new LabError('not_advertised', 'Your PingOne does not advertise this in its discovery document, so the lab does not try it', 409, { trace: found.step ? [found.step] : [] });
    }
    return found;
  }

  async function read({ traceId, fresh }) {
    const configured = issuer();
    if (!fresh && cache && cache.issuer === configured && now() - cache.at < DISCOVERY_TTL_MS) {
      return { metadata: cache.metadata, step: null };
    }
    if (!configured) throw new LabError('not_configured', 'Set the PingOne environment in Settings', 409);
    const url = `${configured}/.well-known/openid-configuration`;
    const result = await call(url, { headers: { Accept: 'application/json' }, traceId });
    const s = hop({ id: 'discovery', title: 'Read PingOne discovery', method: 'GET', url, headers: { Accept: 'application/json' }, result });
    if (result.status !== 200) throw new LabError('discovery_failed', `Discovery answered HTTP ${result.status}`, 502, { trace: [s] });
    let metadata;
    try { metadata = readMetadata(result.json, configured); } catch (error) { error.extra = { trace: [s] }; throw error; }
    cache = { issuer: configured, at: now(), metadata };
    return { metadata, step: s };
  }

  async function jwks(metadata, traceId) {
    const result = await call(metadata.jwksUri, { headers: { Accept: 'application/json' }, traceId });
    if (result.status !== 200 || !Array.isArray(result.json?.keys)) throw new LabError('jwks_failed', `JWKS answered HTTP ${result.status}`);
    return result.json;
  }

  // A form POST to PingOne with client authentication: client_secret_basic when a secret is set, otherwise client_id
  // in the body (a public client, for example PKCE with token auth method None).
  async function formPost({ url, clientId, clientSecret, params, traceId }) {
    const body = new URLSearchParams(params);
    const headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
    if (clientSecret) headers.Authorization = basic(clientId, clientSecret);
    else if (clientId) body.set('client_id', clientId);
    const result = await call(url, { method: 'POST', headers, body: body.toString(), traceId });
    const shownHeaders = { ...headers };
    if (clientSecret) shownHeaders.Authorization = `Basic <${clientId}:client secret>`;
    return { result, body, headers: shownHeaders };
  }

  // A GET with a bearer access token (userinfo). The trace shows the header redacted.
  async function bearerGet({ url, accessToken, traceId }) {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${accessToken}` };
    const result = await call(url, { headers, traceId });
    return { result, headers: { Accept: 'application/json', Authorization: 'Bearer <access token>' } };
  }

  function idToken(token, { metadata, keys, clientId, nonce }) {
    try {
      return verifyIdToken(token, { jwks: keys, issuer: metadata.issuer, audience: clientId, nonce, now });
    } catch (error) {
      if (error instanceof JwtInvalid) throw new LabError('id_token_invalid', `The ID token was refused: ${error.message}`);
      throw error;
    }
  }

  const tokenClaims = (json) => (json ? {
    ...(json.access_token ? { accessToken: claimsOf(json.access_token) } : {}),
    ...(json.id_token ? { idToken: claimsOf(json.id_token) } : {}),
  } : null);

  // The cached metadata for the configured environment, or null: lets the card list say what PingOne advertises without a call.
  const cached = () => (cache && cache.issuer === issuer() && now() - cache.at < DISCOVERY_TTL_MS ? cache.metadata : null);

  return { issuer, discover, cached, jwks, formPost, bearerGet, idToken, tokenClaims, call, clearCache: () => { cache = null; } };
}
