import crypto from 'node:crypto';
import { pkce as newPkce, signHs256 } from './jose.js';
import { LabError, hop } from './p1.js';
import { newTraceId, tokenView, step } from './trace.js';

// Authorization-code runs driven through PingOne's flows API (pi.flow), never a browser redirect: the authorization
// request carries response_mode=pi.flow, PingOne answers with a JSON flow (id, status, _links), the lab's own form
// posts the username (user.lookup, when the policy is identifier-first) and the password (usernamePassword.check) to
// <env>/flows/{id}, and once the flow is COMPLETED the lab asks <env>/as/resume?flowId= for the authorization code.
// The code is redeemed with PKCE, server-side; tokens stay in the server-side session. Sign-in, PKCE, PAR and JAR all
// run on this engine. PingOne ties the flow to its session cookies (ST), so every step replays the cookie jar.

export const FLOW_ID = /^[A-Za-z0-9_-]{6,128}$/;
export const PIFLOW_JSON = 'application/json';
export const USER_LOOKUP = 'application/vnd.pingidentity.user.lookup+json';
export const USERNAME_PASSWORD_CHECK = 'application/vnd.pingidentity.usernamePassword.check+json';
// The statuses at which this lab's form can answer: a username and password, a username first, or a password.
export const CREDENTIAL_STATUSES = new Set(['USERNAME_PASSWORD_REQUIRED', 'SIGN_ON_REQUIRED', 'PASSWORD_REQUIRED']);
const RUN_TTL_MS = 5 * 60 * 1000;
const REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';
const MAX_COOKIES = 30;
const CONTROL = /[\u0000-\u001f\u007f]/;

// PingOne ties a flow to its session cookies, so every step replays the jar and merges what comes back.
export function mergeCookies(jar, setCookies) {
  const next = { ...jar };
  for (const line of setCookies || []) {
    const [pair] = String(line).split(';');
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || value.length > 4096 || CONTROL.test(value)) continue;
    if (!Object.hasOwn(next, name) && Object.keys(next).length >= MAX_COOKIES) continue;
    next[name] = value;
  }
  return next;
}
export const cookieHeader = (jar) => Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; ');

// What a client renders from: status, offered actions, embedded objects. Never the flow id (a bearer handle).
export function flowView(flow) {
  return {
    status: typeof flow?.status === 'string' ? flow.status : null,
    actions: Object.keys(flow?._links || {}).filter((name) => name !== 'self'),
    ...(flow?._embedded ? { embedded: Object.keys(flow._embedded) } : {}),
    ...(typeof flow?.usernameHint === 'string' ? { usernameHint: flow.usernameHint } : {}),
  };
}

export const EXCERPT_INPUT_MAX = 8 * 1024;

// PingOne may answer a refused authorization request as an HTML page: show its words.
// Linear: the input is cut to 8 KB first, then one pass drops <script>/<style> blocks and tags (indexOf only,
// no backtracking regex), and the remaining regexes have no nested or overlapping quantifiers.
export function htmlExcerpt(text) {
  const input = String(text || '').slice(0, EXCERPT_INPUT_MAX);
  const lower = input.toLowerCase();
  let out = '';
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) { out += input.slice(i); break; }
    out += `${input.slice(i, lt)} `;
    let skipTo = -1;
    for (const block of ['script', 'style']) {
      if (lower.startsWith(`<${block}`, lt)) {
        const close = lower.indexOf(`</${block}`, lt);
        const end = close === -1 ? -1 : lower.indexOf('>', close);
        skipTo = end === -1 ? input.length : end + 1;
      }
    }
    if (skipTo === -1) {
      const gt = input.indexOf('>', lt);
      skipTo = gt === -1 ? input.length : gt + 1;
    }
    i = skipTo;
  }
  return out.replace(/&#?[a-z0-9]{1,10};/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

// The JSON PingOne returned, as it came, for the trace. Masked: the flow id wherever it appears (it is a bearer
// handle to the sign-in, also inside _links hrefs), an authorization code, and any token, secret or password value.
// Bounded: depth 12, 50 items per array, 2000 characters per string.
const MASKED_KEY = /token|secret|password|assertion/i;
export function rawFlowBody(json, flowId = null) {
  if (!json || typeof json !== 'object') return null;
  const id = typeof flowId === 'string' && flowId ? flowId : (typeof json.id === 'string' ? json.id : null);
  const walk = (v, depth, key, parent) => {
    if (typeof v === 'string') {
      if (MASKED_KEY.test(key) || (key === 'code' && parent === 'authorizeResponse')) return '<redacted>';
      const s = id ? v.split(id).join('<flow id>') : v;
      return s.length > 2000 ? `${s.slice(0, 2000)}...` : s;
    }
    if (!v || typeof v !== 'object') return v;
    if (depth >= 12) return '...';
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1, key, parent));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1, k, key)]));
  };
  return walk(json, 0, '', '');
}

export const MAX_FLOW_STEPS = 6;
const REQUEST_OBJECT_TTL_S = 300;

const hasOpenid = (scope) => /(^| )openid( |$)/.test(String(scope || ''));
const flowUrl = (metadata, flowId) => `${metadata.authBase}/flows/${flowId}`;
// The flow id is a bearer handle to the sign-in; it never appears in a trace.
const shownFlowUrl = (metadata) => `${metadata.authBase}/flows/<flow id>`;
const badCredentials = (json) => Array.isArray(json?.details) && json.details.some((d) => d?.code === 'INVALID_CREDENTIALS');

export function createPiFlow({ p1, settings, now = Date.now }) {
  const redirectUri = () => settings.value('p1', 'redirectUri');

  async function openFlow({ authorizeUrl, jar, traceId, title }) {
    const headers = { Accept: PIFLOW_JSON, ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}) };
    const result = await p1.call(authorizeUrl, { headers, traceId });
    const nextJar = mergeCookies(jar, result.setCookies);
    const flow = result.json;
    const opened = result.ok && FLOW_ID.test(String(flow?.id || ''));
    const s = hop({
      id: 'authorize',
      title,
      method: 'GET',
      url: authorizeUrl,
      headers: { ...headers, ...(headers.Cookie ? { Cookie: 'x' } : {}) },
      params: new URL(authorizeUrl).searchParams,
      result: { ...result, json: rawFlowBody(result.json) },
      note: opened
        ? 'response_mode=pi.flow: PingOne answers with JSON. The client renders the form named by status and posts to the flow.'
        : (result.json ? null : `PingOne did not open a flow. Page text: ${htmlExcerpt(result.text) || '(empty)'}`),
    });
    return { result, flow: opened ? flow : null, jar: nextJar, step: s };
  }

  async function postStep({ metadata, run, contentType, payload, shownPayload, title, id }) {
    const url = flowUrl(metadata, run.flowId);
    const headers = { 'Content-Type': contentType, Accept: PIFLOW_JSON, Cookie: cookieHeader(run.jar) };
    const result = await p1.call(url, { method: 'POST', headers, body: JSON.stringify(payload), traceId: run.traceId });
    run.jar = mergeCookies(run.jar, result.setCookies);
    run.trace.push(hop({
      id, title, method: 'POST', url: shownFlowUrl(metadata),
      headers: { ...headers, Cookie: 'x' },
      json: shownPayload,
      result: { ...result, json: rawFlowBody(result.json, run.flowId) },
    }));
    return result;
  }

  function clientFor(card) {
    const c = settings.section(card);
    return { clientId: c.clientId, clientSecret: c.clientSecret, scope: c.scope || 'openid profile' };
  }

  // Begin a run. opts: { par, jar, loginHint }. Returns the run's public state.
  async function start(session, card, { par = false, jar = false, loginHint = null } = {}) {
    if (!settings.ready(card)) throw new LabError('not_configured', `Settings for ${card} are incomplete`, 409);
    // A sign-in must prove who signed in: openid in the scope, and a verified ID token at the end.
    if (card === 'signin' && !hasOpenid(settings.value('signin', 'scope'))) throw new LabError('signin_needs_openid', 'The sign-in scope must include openid', 409);
    // login_hint names the user PingOne should sign in; it comes back as the username the form starts with.
    if (loginHint !== null && loginHint !== undefined && typeof loginHint !== 'string') throw new LabError('bad_login_hint', 'The user (login_hint) must be text', 400);
    const hint = typeof loginHint === 'string' ? loginHint.trim() : '';
    if (CONTROL.test(hint)) throw new LabError('bad_login_hint', 'The user (login_hint) must not contain control characters', 400);
    if (hint.length > 256) throw new LabError('bad_login_hint', 'The user (login_hint) must be at most 256 characters', 400);
    const traceId = newTraceId();
    const trace = [];
    const { metadata, step: discoveryStep } = await p1.discover({ traceId, need: card });
    if (discoveryStep) trace.push(discoveryStep);
    const client = clientFor(card);
    const codes = newPkce();
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: redirectUri(),
      scope: client.scope,
      state,
      nonce,
      code_challenge: codes.challenge,
      code_challenge_method: codes.method,
      response_mode: 'pi.flow',
    });
    if (hint) params.set('login_hint', hint);
    // PingOne's session cookies are reused only with the environment that set them.
    const cookieJar = session.p1CookiesFor === metadata.issuer ? { ...(session.p1Cookies || {}) } : {};
    const run = { card, traceId, trace, client, codes, state, nonce, metadata, jar: cookieJar,
      expiresAt: now() + RUN_TTL_MS, status: null, loginHint: hint || null };

    let authorizeUrl;
    if (par) {
      if (!metadata.parEndpoint) throw new LabError('par_not_supported', 'Your PingOne does not advertise a PAR endpoint', 409, { trace });
      const { result, body, headers } = await p1.formPost({ url: metadata.parEndpoint, clientId: client.clientId, clientSecret: client.clientSecret, params, traceId });
      trace.push(hop({ id: 'par', title: 'Push the authorization request (PAR)', method: 'POST', url: metadata.parEndpoint, headers, params: body, result,
        note: result.ok ? 'PingOne kept the request and returned a one-time handle (request_uri).' : null }));
      if (!result.ok) {
        const error = result.json?.error;
        // A refused pushed request is an answer, not a failure.
        if (['invalid_request', 'unauthorized_client', 'invalid_scope', 'invalid_client'].includes(error)) return finishRun(session, run, { outcome: 'refused', reason: error });
        throw new LabError('par_failed', `PingOne refused the pushed request (HTTP ${result.status})`, 502, { trace });
      }
      const requestUri = result.json?.request_uri;
      const expiresIn = result.json?.expires_in;
      if (typeof requestUri !== 'string' || !requestUri.startsWith(REQUEST_URI_PREFIX) || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 3600) {
        throw new LabError('par_response_invalid', 'PingOne PAR answer has no valid request_uri', 502, { trace });
      }
      const url = new URL(metadata.authorizationEndpoint);
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('request_uri', requestUri);
      // UNVERIFIED against a live PingOne: response_mode is sent in the pushed request and repeated here, so the
      // authorization endpoint answers with a pi.flow document rather than a login page.
      url.searchParams.set('response_mode', 'pi.flow');
      authorizeUrl = url.toString();
    } else if (jar) {
      // JAR (RFC 9101): every authorization parameter goes inside a JWT signed HS256 with the client secret.
      // client_id, response_type, scope and response_mode are repeated outside, as OpenID Connect asks.
      const iat = Math.floor(now() / 1000);
      const claims = { ...Object.fromEntries(params), iss: client.clientId, aud: metadata.issuer, iat, exp: iat + REQUEST_OBJECT_TTL_S, jti: crypto.randomUUID() };
      const requestObject = signHs256({ alg: 'HS256', typ: 'oauth-authz-req+jwt' }, claims, client.clientSecret);
      trace.push(step({ id: 'request-object', title: 'Sign the request object (HS256, key = client secret)', request: { body: { header: { alg: 'HS256', typ: 'oauth-authz-req+jwt' }, claims } },
        note: 'The client secret is the HMAC key only; it is not in the JWT. PingOne checks the signature before it trusts any parameter.' }));
      const url = new URL(metadata.authorizationEndpoint);
      for (const name of ['client_id', 'response_type', 'scope', 'response_mode']) url.searchParams.set(name, params.get(name));
      url.searchParams.set('request', requestObject);
      authorizeUrl = url.toString();
    } else {
      const url = new URL(metadata.authorizationEndpoint);
      for (const [k, v] of params) url.searchParams.set(k, v);
      authorizeUrl = url.toString();
    }

    const title = par ? 'Open the flow with the request_uri' : jar ? 'Open the flow with the signed request object' : 'Open a pi.flow authorization request';
    const opened = await openFlow({ authorizeUrl, jar: run.jar, traceId, title });
    trace.push(opened.step);
    run.jar = opened.jar;
    if (!opened.flow) {
      if (opened.result.status === 400 || opened.result.json?.error) {
        const reason = opened.result.json?.error || opened.result.json?.code || `http_${opened.result.status}`;
        return finishRun(session, run, { outcome: 'refused', reason: String(reason).slice(0, 64) });
      }
      throw new LabError('piflow_not_opened', `PingOne did not open a pi.flow (HTTP ${opened.result.status}). The application needs response mode pi.flow allowed.`, 502, { trace });
    }
    run.flowId = opened.flow.id;
    return advance(session, run, opened.flow);
  }

  // Moves a run on from a flow document: done, waiting for credentials, or stopped at a status this lab does not drive
  // (MFA, external IdP, consent): the page shows that status.
  async function advance(session, run, flow) {
    run.status = flow.status;
    run.steps = (run.steps || 0) + 1;
    if (run.steps > MAX_FLOW_STEPS) return finishRun(session, run, { outcome: 'failed', reason: 'too_many_steps' });
    if (flow.status === 'COMPLETED') return complete(session, run);
    session.runs[run.card] = run;
    return publicRun(run, { state: CREDENTIAL_STATUSES.has(flow.status) ? 'credentials_required' : 'stopped', ...flowView(flow) });
  }

  function flowGone(session, run) {
    // PingOne no longer knows the flow: it expired, or it was used up.
    return finishRun(session, run, { outcome: 'failed', reason: 'flow_gone' });
  }

  async function submitCredentials(session, card, { username, password } = {}) {
    const run = session.runs[card];
    if (!run || run.expiresAt <= now() || !run.flowId) throw new LabError('no_run', 'Start this card first (a run expires after 5 minutes)', 409);
    if (!CREDENTIAL_STATUSES.has(run.status)) throw new LabError('wrong_status', `The flow is at ${run.status}, not waiting for a username or password`, 409);
    if (typeof username !== 'string' || !username || username.length > 256 || CONTROL.test(username)) throw new LabError('bad_username', 'Username must be 1 to 256 characters', 400);
    if (typeof password !== 'string' || !password || password.length > 1024) throw new LabError('bad_password', 'Password must be 1 to 1024 characters', 400);
    // Identifier first: PingOne opens at SIGN_ON_REQUIRED and wants the username alone before the password.
    if (run.status === 'SIGN_ON_REQUIRED') {
      const lookup = await postStep({ metadata: run.metadata, run, contentType: USER_LOOKUP, payload: { username }, shownPayload: { username },
        title: 'Name the user (user.lookup)', id: 'lookup' });
      if (lookup.status === 404 || lookup.status === 410) return flowGone(session, run);
      if (!lookup.ok || !lookup.json) return finishRun(session, run, { outcome: 'failed', reason: lookup.json?.code || `http_${lookup.status}` });
      if (lookup.json.status !== 'PASSWORD_REQUIRED' && lookup.json.status !== 'USERNAME_PASSWORD_REQUIRED') return advance(session, run, lookup.json);
      run.status = lookup.json.status;
    }
    const result = await postStep({
      metadata: run.metadata, run, contentType: USERNAME_PASSWORD_CHECK,
      payload: { username, password }, shownPayload: { username, password: '<redacted>' },
      title: 'Post the username and password (usernamePassword.check)', id: 'credentials',
    });
    if (!result.ok) {
      if (result.status === 400 && badCredentials(result.json)) {
        return publicRun(run, { state: 'credentials_required', refused: 'credential_validation_failed', status: run.status });
      }
      if (result.status === 404 || result.status === 410) return flowGone(session, run);
      return finishRun(session, run, { outcome: 'failed', reason: result.json?.code || `http_${result.status}` });
    }
    if (!result.json) return finishRun(session, run, { outcome: 'failed', reason: 'not_json' });
    return advance(session, run, result.json);
  }

  // A COMPLETED flow does not carry the code: PingOne hands it back from <env>/as/resume?flowId=, as JSON
  // (authorizeResponse) or as a redirect to the redirect URI that the lab reads but never follows.
  async function resume(run) {
    const url = `${run.metadata.authBase}/as/resume?flowId=${encodeURIComponent(run.flowId)}`;
    const headers = { Accept: PIFLOW_JSON, Cookie: cookieHeader(run.jar) };
    const result = await p1.call(url, { headers, traceId: run.traceId });
    run.jar = mergeCookies(run.jar, result.setCookies);
    let answer = result.json?.authorizeResponse || null;
    if (!answer && result.rawLocation) {
      try {
        const loc = new URL(result.rawLocation, url);
        answer = Object.fromEntries(['code', 'state', 'error'].filter((k) => loc.searchParams.has(k)).map((k) => [k, loc.searchParams.get(k)]));
      } catch { answer = null; }
    }
    run.trace.push(hop({ id: 'resume', title: 'Ask PingOne for the authorization code (resume)', method: 'GET', url: `${run.metadata.authBase}/as/resume`,
      headers: { ...headers, Cookie: 'x' }, result: { ...result, json: answer ? { authorizeResponse: { ...(answer.code ? { code: '<redacted>' } : {}), ...(answer.state !== undefined ? { state: '<checked>' } : {}), ...(answer.error ? { error: String(answer.error).slice(0, 64) } : {}) } } : rawFlowBody(result.json, run.flowId) },
      note: 'PingOne finishes a pi.flow here: the code comes back in JSON or in a redirect the lab reads and does not follow. Nothing redirects the browser.' }));
    return { result, answer: answer || {} };
  }

  async function complete(session, run) {
    const { result: resumed, answer } = await resume(run);
    if (resumed.status === 404 || resumed.status === 410) return flowGone(session, run);
    session.p1Cookies = run.jar; // the PingOne session now belongs to this lab session (SSO for later runs)
    session.p1CookiesFor = run.metadata.issuer;
    if (answer.state !== undefined && answer.state !== run.state) return finishRun(session, run, { outcome: 'failed', reason: 'state_mismatch' });
    if (answer.error) return finishRun(session, run, { outcome: 'refused', reason: String(answer.error).slice(0, 64) });
    if (typeof answer.code !== 'string' || !answer.code) return finishRun(session, run, { outcome: 'failed', reason: 'no_code' });
    const params = new URLSearchParams({ grant_type: 'authorization_code', code: answer.code, redirect_uri: redirectUri(), code_verifier: run.codes.verifier });
    const { result, body, headers } = await p1.formPost({
      url: run.metadata.tokenEndpoint, clientId: run.client.clientId, clientSecret: run.client.clientSecret, params, traceId: run.traceId,
    });
    run.trace.push(hop({ id: 'token', title: 'Redeem the code (PKCE code_verifier)', method: 'POST', url: run.metadata.tokenEndpoint, headers, params: body, result,
      claims: p1.tokenClaims(result.json) }));
    const tokens = result.json;
    if (!result.ok || typeof tokens?.access_token !== 'string') return finishRun(session, run, { outcome: 'refused', reason: tokens?.error || `http_${result.status}` });

    let identity = null;
    if (run.card === 'signin' || hasOpenid(run.client.scope)) {
      if (typeof tokens.id_token !== 'string') return finishRun(session, run, { outcome: 'failed', reason: 'no_id_token' });
      const keys = await p1.jwks(run.metadata, run.traceId);
      const claims = p1.idToken(tokens.id_token, { metadata: run.metadata, keys, clientId: run.client.clientId, nonce: run.nonce });
      identity = { subject: String(claims.sub), username: typeof claims.preferred_username === 'string' ? claims.preferred_username : null, issuer: claims.iss, expiresAt: new Date(claims.exp * 1000).toISOString() };
    }
    return finishRun(session, run, {
      outcome: 'accepted',
      tokenType: typeof tokens.token_type === 'string' ? tokens.token_type : null,
      identity,
      scope: typeof tokens.scope === 'string' ? tokens.scope : null,
      refreshToken: typeof tokens.refresh_token === 'string',
      accessToken: tokenView(tokens.access_token),
      idToken: tokenView(tokens.id_token),
    }, tokens);
  }

  function finishRun(session, run, result, tokens = null) {
    const done = { card: run.card, state: 'done', ...result, trace: run.trace, completedAt: new Date(now()).toISOString() };
    delete session.runs[run.card];
    session.results[run.card] = done;
    if (tokens) session.tokens[run.card] = { accessToken: tokens.access_token, idToken: tokens.id_token || null, refreshToken: tokens.refresh_token || null, tokenType: done.tokenType };
    return done;
  }

  const publicRun = (run, extra) => ({ card: run.card, ...(run.loginHint ? { loginHint: run.loginHint } : {}), ...extra, trace: run.trace, expiresAt: new Date(run.expiresAt).toISOString() });

  // pi.flow open-and-read: open a flow with the sign-in client, read it back, show status and actions. Sends no
  // credential and no existing PingOne session cookie, so the flow always starts fresh.
  async function openAndRead() {
    if (!settings.ready('piflow')) throw new LabError('not_configured', 'Set the environment and the sign-in client in Settings', 409);
    const traceId = newTraceId();
    const trace = [];
    const { metadata, step: discoveryStep } = await p1.discover({ traceId, need: 'piflow' });
    if (discoveryStep) trace.push(discoveryStep);
    const client = settings.section('signin');
    const url = new URL(metadata.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: client.clientId, redirect_uri: redirectUri(), scope: client.scope,
      state: crypto.randomBytes(12).toString('base64url'), code_challenge: newPkce().challenge, code_challenge_method: 'S256', response_mode: 'pi.flow',
    }).toString();
    const opened = await openFlow({ authorizeUrl: url.toString(), jar: {}, traceId, title: 'Ask PingOne for a sign-in flow instead of a login page' });
    trace.push(opened.step);
    if (!opened.flow) throw new LabError('piflow_not_opened', `PingOne did not open a pi.flow (HTTP ${opened.result.status})`, 502, { trace });
    const headers = { Accept: PIFLOW_JSON, Cookie: cookieHeader(opened.jar) };
    const again = await p1.call(flowUrl(metadata, opened.flow.id), { headers, traceId });
    trace.push(hop({ id: 'read', title: 'Read the flow back from the flows API', method: 'GET', url: shownFlowUrl(metadata),
      headers: { ...headers, Cookie: 'x' }, result: { ...again, json: rawFlowBody(again.json, opened.flow.id) },
      note: 'The flow and its state live on PingOne. A client moves it on by posting to it; this card sends nothing.' }));
    const view = flowView(again.ok && again.json ? again.json : opened.flow);
    return { status: view.status, actions: view.actions, trace };
  }

  return { start, submitCredentials, openAndRead };
}
