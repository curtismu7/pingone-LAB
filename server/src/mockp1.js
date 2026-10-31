// The lab's in-process mock PingOne (mock mode), also the fake the tests use. It answers through an injected
// fetchImpl and never opens a socket: in mock mode the outbound door hands every call to fetchImpl() below instead of
// the network. Its shapes follow PingOne's documented flows API and OAuth endpoints. It records every call and
// remembers every secret it hands out, so tests can prove none of them reaches the page.
// In mock mode it lives on MOCK_ORIGIN, an .invalid host that cannot resolve, so even a routing mistake could not
// reach a real PingOne. Every token it signs names that issuer, which is how the page labels them as mock.
import crypto from 'node:crypto';
import { createEcKey, signEs256, s256 } from './jose.js';

export const ENV_ID = '00000000-0000-4000-8000-000000000001';
export const MOCK_ORIGIN = 'https://auth.pingone-mock.invalid';

// Every token the mock signs is remembered here (bounded), so the trace can tell a token this process's mock issued
// from a token anyone else shows: only the first kind is displayed whole (rule 4, owner exception 2026-10-31).
// A token that merely CLAIMS the mock issuer, for example one from a live response, is not in this set.
const ISSUED = new Set();
const ISSUED_MAX = 5000;
export function wasIssuedByMock(value) { return typeof value === 'string' && ISSUED.has(value); }
function noteIssued(value) {
  ISSUED.add(value);
  if (ISSUED.size > ISSUED_MAX) ISSUED.delete(ISSUED.values().next().value);
  return value;
}
// The demo user exists only in the mock. Its password is published in the README and on the sign-in dialog.
export const USER = { username: 'alice', password: 'correct-horse-battery', sub: 'user-alice-0001' };
// What the mock's userinfo knows about the demo user, released by scope as PingOne does.
const PROFILE = {
  profile: { name: 'Alice Example', given_name: 'Alice', family_name: 'Example', preferred_username: 'alice', locale: 'en-US', zoneinfo: 'America/Chicago' },
  email: { email: 'alice@example.invalid', email_verified: true },
  address: { address: { street_address: '1 Example Way', locality: 'Austin', region: 'TX', postal_code: '78701', country: 'US' } },
  phone: { phone_number: '+1 555 0100', phone_number_verified: false },
};

// The clients mock mode configures (settings overlay) and the mock knows. Secrets are throwaway values for the mock.
export const MOCK_CLIENTS = {
  signin: { clientId: 'mock-signin', clientSecret: 'mock-signin-secret-0001' },
  pkce: { clientId: 'mock-pkce' },
  par: { clientId: 'mock-par', clientSecret: 'mock-par-secret-0001' },
  jar: { clientId: 'mock-jar', clientSecret: 'mock-jar-secret-0001' },
  clientCredentials: { clientId: 'mock-cc', clientSecret: 'mock-cc-secret-0001', scope: 'lab:read' },
  device: { clientId: 'mock-device' },
  ciba: { clientId: 'mock-ciba', clientSecret: 'mock-ciba-secret-0001' },
  tokenExchange: {
    exchangeClientId: 'mock-exchange', exchangeClientSecret: 'mock-exchange-secret-0001',
    actorClientId: 'mock-actor', actorClientSecret: 'mock-actor-secret-0001', actorScope: 'agent:invoke',
  },
};
// The same clients as the mock sees them: id -> { secret, scopes }.
export function mockClientTable() {
  const out = {};
  for (const c of Object.values(MOCK_CLIENTS)) {
    if (c.clientId) out[c.clientId] = { secret: c.clientSecret, scopes: c.scope ? c.scope.split(' ') : [] };
    if (c.exchangeClientId) out[c.exchangeClientId] = { secret: c.exchangeClientSecret, scopes: [] };
    if (c.actorClientId) out[c.actorClientId] = { secret: c.actorClientSecret, scopes: c.actorScope.split(' ') };
  }
  return out;
}

const MAX_ENTRIES = 500;
const rand = (n = 18) => crypto.randomBytes(n).toString('base64url');
const json = (status, body, extra = {}) => {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'set-cookie') for (const c of [].concat(v)) headers.append('set-cookie', c);
    else headers.set(k, v);
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
};
const html = (status, text) => new Response(`<html><body><h1>${text}</h1></body></html>`, { status, headers: { 'Content-Type': 'text/html' } });

function cookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

function decodeJwt(token) {
  const [h, p] = String(token).split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')) };
}

// options: origin (default MOCK_ORIGIN), envId, clients (id -> { secret, scopes }), identifierFirst, authorizeBody (an HTML answer), resumeMode ('json' | 'redirect'), mfa (stop at
// MFA_REQUIRED), cibaPolls, cibaDecision, devicePolls, deviceDecision, noAct, discovery (overrides), noRefresh
export function createMockP1(options = {}) {
  const ORIGIN = options.origin || MOCK_ORIGIN;
  const envId = options.envId || ENV_ID;
  const base = `${ORIGIN}/${envId}`;
  const issuer = `${base}/as`;
  const key = createEcKey();
  const kid = ORIGIN === MOCK_ORIGIN ? 'mock-1' : 'fake-1';
  const calls = [];
  const secrets = new Set([USER.password]);
  // track: false (the lab's mock mode) keeps no call log or secret list; tests keep both.
  const track = options.track !== false;
  const remember = (value) => { if (track) secrets.add(value); return value; };
  const clients = new Map(Object.entries(options.clients || {}));
  for (const c of clients.values()) if (c.secret) secrets.add(c.secret);
  const flows = new Map();
  const codes = new Map();
  const pushed = new Map();
  const cibas = new Map();
  const devices = new Map();
  const tokens = new Map(); // access token -> claims
  const refreshes = new Map(); // refresh token -> { client, sub, scope, revoked }
  let ssoCookie = null;

  // Signed tokens are shown whole in mock mode, so they are not tracked as secrets; codes, refresh tokens, cookies and
  // request objects still are.
  const sign = (payload, typ = 'JWT') => noteIssued(signEs256({ alg: 'ES256', kid, typ }, payload, key.privateKey));
  const now = () => Math.floor(Date.now() / 1000);
  const accessToken = (claims) => { const t = sign({ iss: issuer, iat: now(), exp: now() + 300, jti: rand(), ...claims }); tokens.set(t, claims); return t; };
  const idToken = (sub, aud, nonce) => sign({ iss: issuer, sub, aud, ...(nonce ? { nonce } : {}), preferred_username: USER.username, iat: now(), exp: now() + 300, ...(options.idTokenClaims || {}) });

  const discovery = {
    issuer: issuer,
    authorization_endpoint: `${issuer}/authorize`,
    pushed_authorization_request_endpoint: `${issuer}/par`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    introspection_endpoint: `${issuer}/introspect`,
    revocation_endpoint: `${issuer}/revoke`,
    device_authorization_endpoint: `${issuer}/device_authorization`,
    backchannel_authentication_endpoint: `${issuer}/cibaAuthorization`,
    request_parameter_supported: true,
    request_uri_parameter_supported: false,
    response_modes_supported: ['pi.flow', 'query', 'fragment', 'form_post'],
    grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:openid:params:grant-type:ciba', 'urn:ietf:params:oauth:grant-type:token-exchange'],
    request_object_signing_alg_values_supported: ['none', 'HS256', 'RS256'],
    backchannel_token_delivery_modes_supported: ['poll'],
    code_challenge_methods_supported: ['plain', 'S256'],
    ...(options.discovery || {}),
  };

  function clientAuth(req, form) {
    const auth = req.headers.get('authorization') || '';
    let id = form.get('client_id');
    let secret = null;
    if (auth.startsWith('Basic ')) {
      const [a, b] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      id = decodeURIComponent(a); secret = decodeURIComponent(b);
    }
    const client = clients.get(id);
    if (!client) return null;
    if (client.secret && client.secret !== secret) return null;
    return { id, ...client };
  }

  const flowDoc = (flow) => ({ id: flow.id, status: flow.status, _links: { self: { href: `${base}/flows/${flow.id}` } } });

  function verifyRequestObject(jwt, client) {
    try {
      const [h, p, s] = jwt.split('.');
      const { header, payload } = decodeJwt(jwt);
      if (header.alg !== 'HS256' || !client.secret) return null;
      const good = crypto.createHmac('sha256', client.secret).update(`${h}.${p}`).digest('base64url');
      if (good !== s) return null;
      if (payload.iss !== client.id || payload.aud !== issuer || payload.exp < now()) return null;
      return payload;
    } catch { return null; }
  }

  async function authorize(url, req) {
    let params = Object.fromEntries(url.searchParams);
    if (params.request_uri) {
      const p = pushed.get(params.request_uri);
      if (!p || p.client_id !== params.client_id) return json(400, { error: 'invalid_request_uri' });
      pushed.delete(params.request_uri);
      params = { ...p, response_mode: url.searchParams.get('response_mode') || p.response_mode };
    }
    const client = clients.get(params.client_id);
    if (options.authorizeBody) return new Response(options.authorizeBody, { status: 400, headers: { 'Content-Type': 'text/html' } });
    if (!client) return json(400, { error: 'invalid_client' });
    if (params.request) {
      remember(params.request);
      const claims = verifyRequestObject(params.request, { id: params.client_id, ...client });
      if (!claims) return json(400, { error: 'invalid_request_object', error_description: 'The request object signature did not verify' });
      if (claims.scope !== params.scope) return json(400, { error: 'invalid_request_object', error_description: 'scope differs from the request object' });
      params = { ...claims };
    }
    if (params.response_mode !== 'pi.flow' || !/json/.test(req.headers.get('accept') || '')) return html(200, 'Login page');
    const jar = cookies(req.headers.get('cookie'));
    const id = crypto.randomUUID();
    const flow = { id, params, cookie: rand(), status: options.identifierFirst ? 'SIGN_ON_REQUIRED' : 'USERNAME_PASSWORD_REQUIRED' };
    remember(flow.cookie); remember(id);
    if (ssoCookie && jar.ST === ssoCookie) flow.status = 'COMPLETED';
    flows.set(id, flow);
    return json(200, flowDoc(flow), { 'set-cookie': [`ST=${flow.status === 'COMPLETED' ? ssoCookie : flow.cookie}; Path=/; Secure; HttpOnly`] });
  }

  async function flowStep(url, req, id) {
    const flow = flows.get(id);
    if (!flow) return json(404, { code: 'NOT_FOUND', message: 'The flow was not found' });
    const jar = cookies(req.headers.get('cookie'));
    if (jar.ST !== flow.cookie && jar.ST !== ssoCookie) return json(400, { code: 'INVALID_DATA', message: 'Session token cookie value does not match' });
    if (req.method === 'GET') return json(200, flowDoc(flow));
    const type = req.headers.get('content-type');
    const body = JSON.parse(await req.text());
    if (type === 'application/vnd.pingidentity.user.lookup+json') {
      if (flow.status !== 'SIGN_ON_REQUIRED') return json(400, { code: 'INVALID_REQUEST', message: 'wrong flow status' });
      flow.status = 'PASSWORD_REQUIRED';
      flow.username = body.username;
      return json(200, flowDoc(flow));
    }
    if (type !== 'application/vnd.pingidentity.usernamePassword.check+json') return json(415, { code: 'UNSUPPORTED_MEDIA_TYPE' });
    if (!['USERNAME_PASSWORD_REQUIRED', 'PASSWORD_REQUIRED'].includes(flow.status)) return json(400, { code: 'INVALID_REQUEST', message: 'wrong flow status' });
    if (body.username !== USER.username || body.password !== USER.password) {
      return json(400, { code: 'INVALID_DATA', message: 'Invalid credentials', details: [{ code: 'INVALID_CREDENTIALS', message: 'The provided password did not match' }] });
    }
    if (options.mfa) { flow.status = 'MFA_REQUIRED'; return json(200, flowDoc(flow)); }
    flow.status = 'COMPLETED';
    ssoCookie = remember(rand());
    flow.cookie = ssoCookie;
    return json(200, flowDoc(flow), { 'set-cookie': [`ST=${ssoCookie}; Path=/; Secure; HttpOnly`] });
  }

  function resume(url, req) {
    const flow = flows.get(url.searchParams.get('flowId'));
    if (!flow) return json(404, { code: 'NOT_FOUND' });
    if (flow.status !== 'COMPLETED') return json(400, { code: 'INVALID_REQUEST', message: 'flow not completed' });
    const code = remember(rand());
    codes.set(code, { params: flow.params, sub: USER.sub });
    flows.delete(flow.id);
    const state = options.wrongState ? 'not-your-state' : flow.params.state;
    if (options.resumeMode === 'redirect') {
      const to = new URL(flow.params.redirect_uri);
      to.searchParams.set('code', code);
      to.searchParams.set('state', state);
      return new Response(null, { status: 302, headers: { Location: to.toString() } });
    }
    return json(200, { authorizeResponse: { code, state } });
  }

  function issueUserTokens(client, sub, scope, nonce) {
    const at = accessToken({ sub, client_id: client.id, scope, aud: ['https://api.pingone.com'] });
    const refresh = options.noRefresh ? null : remember(rand());
    if (refresh) refreshes.set(refresh, { client: client.id, sub, scope, revoked: false });
    return { access_token: at, ...(String(scope).split(' ').includes('openid') ? { id_token: idToken(sub, client.id, nonce) } : {}), ...(refresh ? { refresh_token: refresh } : {}), token_type: 'Bearer', expires_in: 300, scope };
  }

  async function token(url, req) {
    const form = new URLSearchParams(await req.text());
    const client = clientAuth(req, form);
    if (!client) return json(401, { error: 'invalid_client' });
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const entry = codes.get(form.get('code'));
      if (!entry || entry.params.client_id !== client.id) return json(400, { error: 'invalid_grant' });
      remember(form.get('code_verifier'));
      if (s256(form.get('code_verifier') || '') !== entry.params.code_challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      if (form.get('redirect_uri') !== entry.params.redirect_uri) return json(400, { error: 'invalid_grant' });
      codes.delete(form.get('code'));
      return json(200, issueUserTokens(client, entry.sub, entry.params.scope, entry.params.nonce));
    }
    if (grant === 'refresh_token') {
      const r = refreshes.get(form.get('refresh_token'));
      if (!r || r.revoked || r.client !== client.id) return json(400, { error: 'invalid_grant', error_description: 'The refresh token is invalid or revoked' });
      refreshes.delete(form.get('refresh_token'));
      return json(200, issueUserTokens(client, r.sub, r.scope));
    }
    if (grant === 'client_credentials') {
      const scope = form.get('scope') || '';
      const allowed = new Set(client.scopes || []);
      if (scope && !scope.split(' ').every((s) => allowed.has(s))) return json(400, { error: 'invalid_scope' });
      const at = accessToken({ client_id: client.id, scope: scope || undefined, aud: ['https://api.example'] });
      return json(200, { access_token: at, token_type: 'Bearer', expires_in: 3600, ...(scope ? { scope } : {}) });
    }
    if (grant === 'urn:ietf:params:oauth:grant-type:token-exchange') {
      const subject = tokens.get(form.get('subject_token'));
      if (!subject) return json(400, { error: 'invalid_request', error_description: 'subject_token is not valid' });
      const actor = form.get('actor_token') ? tokens.get(form.get('actor_token')) : null;
      if (form.get('actor_token') && !actor) return json(400, { error: 'invalid_request', error_description: 'actor_token is not valid' });
      const act = actor && !options.noAct ? { act: { sub: actor.client_id } } : {};
      const at = accessToken({ sub: subject.sub, client_id: client.id, scope: form.get('scope') || undefined, aud: options.exchangeAud || 'https://api.example', ...act });
      return json(200, { access_token: at, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 300 });
    }
    if (grant === 'urn:openid:params:grant-type:ciba') {
      const ciba = cibas.get(form.get('auth_req_id'));
      if (!ciba || ciba.client !== client.id) return json(400, { error: 'invalid_grant' });
      ciba.polls += 1;
      if (ciba.polls < (options.cibaPolls ?? 2)) return json(400, { error: 'authorization_pending' });
      if ((options.cibaDecision || 'approved') === 'denied') return json(400, { error: 'access_denied' });
      return json(200, issueUserTokens(client, USER.sub, ciba.scope));
    }
    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      const d = devices.get(form.get('device_code'));
      if (!d || d.client !== client.id) return json(400, { error: 'invalid_grant' });
      d.polls += 1;
      if (d.polls < (options.devicePolls ?? 2)) return json(400, { error: 'authorization_pending' });
      if ((options.deviceDecision || 'approved') === 'denied') return json(400, { error: 'access_denied' });
      return json(200, issueUserTokens(client, USER.sub, d.scope));
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  async function par(url, req) {
    const form = new URLSearchParams(await req.text());
    const client = clientAuth(req, form);
    if (!client) return json(401, { error: 'invalid_client' });
    const uri = `urn:ietf:params:oauth:request_uri:${rand()}`;
    pushed.set(uri, { ...Object.fromEntries(form), client_id: client.id });
    return json(201, { request_uri: uri, expires_in: 60 });
  }

  async function backchannel(url, req) {
    const form = new URLSearchParams(await req.text());
    const client = clientAuth(req, form);
    if (!client) return json(401, { error: 'invalid_client' });
    if (form.get('login_hint') !== USER.username) return json(400, { error: 'unknown_user_id' });
    const id = remember(rand());
    cibas.set(id, { client: client.id, scope: form.get('scope'), polls: 0 });
    return json(200, { auth_req_id: id, expires_in: 120, interval: 1 });
  }

  async function device(url, req) {
    const form = new URLSearchParams(await req.text());
    const client = clientAuth(req, form);
    if (!client) return json(401, { error: 'invalid_client' });
    const code = remember(rand());
    const userCode = options.deviceUserCode || 'WDJB-MJHT';
    devices.set(code, { client: client.id, scope: form.get('scope'), polls: 0 });
    return json(200, {
      device_code: code, user_code: userCode, verification_uri: options.verificationUri || `${base}/device`,
      verification_uri_complete: `${options.verificationUri || `${base}/device`}?user_code=${userCode}`, expires_in: 600, interval: 1,
    });
  }

  async function introspect(url, req) {
    const form = new URLSearchParams(await req.text());
    if (!clientAuth(req, form)) return json(401, { error: 'invalid_client' });
    const claims = tokens.get(form.get('token'));
    return json(200, claims ? { active: true, sub: claims.sub, client_id: claims.client_id, scope: claims.scope } : { active: false });
  }

  async function revoke(url, req) {
    const form = new URLSearchParams(await req.text());
    if (!clientAuth(req, form)) return json(401, { error: 'invalid_client' });
    const r = refreshes.get(form.get('token'));
    if (r) r.revoked = true;
    return new Response(null, { status: 200 });
  }

  function userinfo(url, req) {
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
    const claims = tokens.get(bearer);
    if (!claims) return json(401, { error: 'invalid_token' });
    const scopes = String(claims.scope || '').split(' ');
    const released = Object.assign({}, ...Object.entries(PROFILE).filter(([scope]) => scopes.includes(scope)).map(([, c]) => c));
    return json(200, { sub: claims.sub, preferred_username: USER.username, given_name: 'Alice', ...released });
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    const req = new Request(url, { method: init.method || 'GET', headers: init.headers, body: init.body });
    if (track) calls.push({ origin: url.origin, path: url.pathname, method: req.method, headers: Object.fromEntries(req.headers), redirect: init.redirect });
    // A long-running mock forgets its oldest state rather than growing without bound.
    for (const m of [flows, codes, pushed, cibas, devices, tokens, refreshes]) while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value);
    if (url.origin !== ORIGIN || !url.pathname.startsWith(`/${envId}/`)) throw new Error(`mock PingOne got a call for ${url.origin}${url.pathname}`);
    const p = url.pathname.slice(envId.length + 1);
    if (p === '/as/.well-known/openid-configuration') return json(200, discovery);
    if (p === '/as/jwks') return json(200, { keys: [{ ...key.publicJwk, kid, use: 'sig', alg: 'ES256' }] });
    if (p === '/as/authorize') return authorize(url, req);
    if (p.startsWith('/flows/')) return flowStep(url, req, p.split('/').pop());
    if (p === '/as/resume') return resume(url, req);
    if (p === '/as/token') return token(url, req);
    if (p === '/as/par') return par(url, req);
    if (p === '/as/cibaAuthorization') return backchannel(url, req);
    if (p === '/as/device_authorization') return device(url, req);
    if (p === '/as/introspect') return introspect(url, req);
    if (p === '/as/revoke') return revoke(url, req);
    if (p === '/as/userinfo') return userinfo(url, req);
    return html(404, 'Not found');
  }

  // forgetFlows: what flow expiry does to pi.flow flows in progress.
  return { fetchImpl, calls, secrets, clients, decodeJwt, origin: ORIGIN, envId, forgetFlows: () => flows.clear() };
}
