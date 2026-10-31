import { LabError, hop } from './p1.js';
import { newTraceId, tokenView } from './trace.js';

// The cards that are one or a few token-endpoint calls rather than a sign-in: client credentials, the token
// lifecycle (refresh, introspect, revoke) and userinfo on the signed-in user's tokens, and the device authorization
// grant (RFC 8628). Tokens and the device code stay in the server-side session; the page sees masked tokens, claims
// and the redacted trace.

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_DEVICE_MS = 10 * 60 * 1000;
const clamp = (seconds) => Math.min(30, Math.max(1, Number.isFinite(seconds) ? Math.floor(seconds) : 5));

export function createGrants({ p1, settings, now = Date.now }) {
  async function begin(need) {
    const traceId = newTraceId();
    const trace = [];
    const { metadata, step } = await p1.discover({ traceId, need });
    if (step) trace.push(step);
    return { traceId, trace, metadata };
  }

  async function clientCredentials(session) {
    if (!settings.ready('clientCredentials')) throw new LabError('not_configured', 'Set the client-credentials application in Settings', 409);
    const c = settings.section('clientCredentials');
    const { traceId, trace, metadata } = await begin('clientCredentials');
    const params = { grant_type: 'client_credentials', ...(c.scope ? { scope: c.scope } : {}) };
    const { result, body, headers } = await p1.formPost({ url: metadata.tokenEndpoint, clientId: c.clientId, clientSecret: c.clientSecret, params, traceId });
    trace.push(hop({ id: 'token', title: 'Ask for a token as the application itself (client_credentials)', method: 'POST', url: metadata.tokenEndpoint, headers, params: body, result,
      claims: p1.tokenClaims(result.json), note: 'No user: the token speaks for the application. PingOne grants only scopes of a resource assigned to the application.' }));
    const out = result.ok && typeof result.json?.access_token === 'string'
      ? { outcome: 'accepted', scope: typeof result.json.scope === 'string' ? result.json.scope : null, expiresIn: Number.isFinite(result.json.expires_in) ? result.json.expires_in : null,
        accessToken: tokenView(result.json.access_token), trace }
      : { outcome: 'refused', reason: typeof result.json?.error === 'string' ? result.json.error.slice(0, 64) : `http_${result.status}`, trace };
    session.results.clientCredentials = out;
    return out;
  }

  // The lifecycle steps are separate calls; their traces chain into one run, which starts again at the first refresh.
  function chained(session, out, { first = false } = {}) {
    const before = first || !Array.isArray(session.lifecycleTrace) ? [] : session.lifecycleTrace;
    session.lifecycleTrace = [...before, ...out.trace].slice(-40);
    const result = { ...out, trace: session.lifecycleTrace };
    session.results.lifecycle = result;
    return result;
  }

  function signedInTokens(session) {
    const tokens = session.tokens.signin;
    if (!session.user || !tokens?.accessToken) throw new LabError('signin_required', 'Sign in with PingOne first: this card works on your tokens', 409);
    return tokens;
  }

  // Lifecycle, one step per call so the Playground can run them one at a time: refresh, introspect, revoke, then a
  // refresh with the revoked token, which PingOne must refuse.
  async function refresh(session, { afterRevoke = false } = {}) {
    if (!settings.ready('lifecycle')) throw new LabError('not_configured', 'Set the environment and the sign-in client in Settings', 409);
    const tokens = signedInTokens(session);
    if (!tokens.refreshToken) throw new LabError('no_refresh_token', 'Your sign-in got no refresh token: turn on the Refresh Token grant for the sign-in application, then sign in again', 409);
    const c = settings.section('signin');
    const { traceId, trace, metadata } = await begin('lifecycle');
    const params = { grant_type: 'refresh_token', refresh_token: tokens.refreshToken };
    const { result, body, headers } = await p1.formPost({ url: metadata.tokenEndpoint, clientId: c.clientId, clientSecret: c.clientSecret, params, traceId });
    trace.push(hop({ id: afterRevoke ? 'refresh-revoked' : 'refresh', title: afterRevoke ? 'Try the revoked refresh token again' : 'Refresh: trade the refresh token for new tokens',
      method: 'POST', url: metadata.tokenEndpoint, headers, params: body, result, claims: p1.tokenClaims(result.json) }));
    if (!result.ok || typeof result.json?.access_token !== 'string') {
      return chained(session, { outcome: 'refused', reason: typeof result.json?.error === 'string' ? result.json.error.slice(0, 64) : `http_${result.status}`, trace }, { first: !afterRevoke });
    }
    // PingOne may rotate the refresh token; keep whichever it returned.
    session.tokens.signin = { ...tokens, accessToken: result.json.access_token, idToken: result.json.id_token || tokens.idToken, refreshToken: result.json.refresh_token || tokens.refreshToken };
    return chained(session, { outcome: 'accepted', rotated: typeof result.json.refresh_token === 'string' && result.json.refresh_token !== tokens.refreshToken, accessToken: tokenView(result.json.access_token), trace }, { first: !afterRevoke });
  }

  async function introspect(session) {
    const tokens = signedInTokens(session);
    const c = settings.section('signin');
    const { traceId, trace, metadata } = await begin('lifecycle');
    if (!metadata.introspectionEndpoint) throw new LabError('introspection_not_supported', 'Your PingOne does not advertise an introspection endpoint', 409, { trace });
    const params = { token: tokens.accessToken, token_type_hint: 'access_token' };
    const { result, body, headers } = await p1.formPost({ url: metadata.introspectionEndpoint, clientId: c.clientId, clientSecret: c.clientSecret, params, traceId });
    trace.push(hop({ id: 'introspect', title: 'Introspect the access token', method: 'POST', url: metadata.introspectionEndpoint, headers, params: body, result }));
    if (!result.ok || typeof result.json?.active !== 'boolean') return chained(session, { outcome: 'refused', reason: typeof result.json?.error === 'string' ? result.json.error.slice(0, 64) : `http_${result.status}`, trace });
    return chained(session, { outcome: 'accepted', active: result.json.active, trace });
  }

  async function revoke(session) {
    const tokens = signedInTokens(session);
    if (!tokens.refreshToken) throw new LabError('no_refresh_token', 'There is no refresh token to revoke', 409);
    const c = settings.section('signin');
    const { traceId, trace, metadata } = await begin('lifecycle');
    if (!metadata.revocationEndpoint) throw new LabError('revocation_not_supported', 'Your PingOne does not advertise a revocation endpoint', 409, { trace });
    const params = { token: tokens.refreshToken, token_type_hint: 'refresh_token' };
    const { result, body, headers } = await p1.formPost({ url: metadata.revocationEndpoint, clientId: c.clientId, clientSecret: c.clientSecret, params, traceId });
    trace.push(hop({ id: 'revoke', title: 'Revoke the refresh token', method: 'POST', url: metadata.revocationEndpoint, headers, params: body, result,
      note: 'A JWT access token stays valid until it expires: revocation stops the refresh token, so no new access tokens.' }));
    if (!result.ok) return chained(session, { outcome: 'refused', reason: typeof result.json?.error === 'string' ? result.json.error.slice(0, 64) : `http_${result.status}`, trace });
    return chained(session, { outcome: 'accepted', revoked: 'refresh_token', trace });
  }

  async function userinfo(session) {
    if (!settings.ready('userinfo')) throw new LabError('not_configured', 'Set the environment and the sign-in client in Settings', 409);
    const tokens = signedInTokens(session);
    const { traceId, trace, metadata } = await begin('userinfo');
    if (!metadata.userinfoEndpoint) throw new LabError('userinfo_not_supported', 'Your PingOne does not advertise a userinfo endpoint', 409, { trace });
    const { result, headers } = await p1.bearerGet({ url: metadata.userinfoEndpoint, accessToken: tokens.accessToken, traceId });
    trace.push(hop({ id: 'userinfo', title: 'Read the user\'s claims (userinfo)', method: 'GET', url: metadata.userinfoEndpoint, headers, result }));
    const out = result.ok && result.json
      ? { outcome: 'accepted', sub: typeof result.json.sub === 'string' ? result.json.sub : null, subMatches: result.json.sub === session.user.subject, claims: Object.keys(result.json).slice(0, 40), trace }
      : { outcome: 'refused', reason: typeof result.json?.error === 'string' ? result.json.error.slice(0, 64) : `http_${result.status}`, trace };
    session.results.userinfo = out;
    return out;
  }

  // Device authorization (RFC 8628): PingOne gives a user code and a verification address; the person signs in there
  // on any device (PingOne's own pages: this is the one card where the sign-in is not in the lab) while the lab polls.
  async function deviceStart(session) {
    if (!settings.ready('device')) throw new LabError('not_configured', 'Set the device-authorization application in Settings', 409);
    const c = settings.section('device');
    const { traceId, trace, metadata } = await begin('device');
    if (!metadata.deviceEndpoint) throw new LabError('device_not_supported', 'Your PingOne does not advertise a device authorization endpoint', 409, { trace });
    const { result, body, headers } = await p1.formPost({ url: metadata.deviceEndpoint, clientId: c.clientId, clientSecret: c.clientSecret, params: { scope: c.scope }, traceId });
    trace.push(hop({ id: 'start', title: 'Ask for a user code (device authorization)', method: 'POST', url: metadata.deviceEndpoint, headers, params: body, result }));
    const d = result.json;
    if (!result.ok) return { state: 'refused', reason: typeof d?.error === 'string' ? d.error.slice(0, 64) : `http_${result.status}`, trace };
    if (typeof d?.device_code !== 'string' || typeof d.user_code !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(d.user_code) || !Number.isFinite(d.expires_in) || d.expires_in <= 0) {
      throw new LabError('device_response_invalid', 'PingOne returned an invalid device authorization response', 502, { trace });
    }
    // Only a verification address on this environment's PingOne host is shown as a link.
    const onPingOne = (value) => {
      try { const u = new URL(value); return u.protocol === 'https:' && u.origin === new URL(metadata.issuer).origin ? u.toString() : null; } catch { return null; }
    };
    session.device = {
      traceId, trace, metadata, deviceCode: d.device_code, userCode: d.user_code,
      verificationUri: onPingOne(d.verification_uri), verificationUriComplete: onPingOne(d.verification_uri_complete),
      interval: clamp(d.interval), lastPolledAt: 0, polls: 0, expiresAt: now() + Math.min(d.expires_in * 1000, MAX_DEVICE_MS),
    };
    delete session.results.device;
    return deviceView(session.device);
  }

  const deviceView = (run) => ({ state: 'pending', userCode: run.userCode, verificationUri: run.verificationUri, verificationUriComplete: run.verificationUriComplete,
    interval: run.interval, polls: run.polls, expiresAt: new Date(run.expiresAt).toISOString(), trace: run.trace });

  function deviceFinish(session, run, state, extra = {}) {
    session.device = null;
    const out = { state, userCode: run.userCode, polls: run.polls, ...extra, trace: run.trace, completedAt: new Date(now()).toISOString() };
    session.results.device = out;
    return out;
  }

  async function devicePoll(session) {
    const run = session.device;
    if (!run) return session.results.device || { state: 'none' };
    if (run.expiresAt <= now()) return deviceFinish(session, run, 'expired', { reason: 'timed_out' });
    if (now() - run.lastPolledAt < run.interval * 1000) return deviceView(run);
    run.lastPolledAt = now();
    run.polls += 1;
    const c = settings.section('device');
    const { result, body, headers } = await p1.formPost({ url: run.metadata.tokenEndpoint, clientId: c.clientId, clientSecret: c.clientSecret,
      params: { grant_type: DEVICE_GRANT, device_code: run.deviceCode }, traceId: run.traceId });
    const error = result.json?.error;
    if (!result.ok && (error === 'authorization_pending' || error === 'slow_down')) {
      if (error === 'slow_down') run.interval = clamp(run.interval + 5);
      return deviceView(run);
    }
    run.trace.push(hop({ id: 'poll', title: 'Poll for the tokens (device_code grant)', method: 'POST', url: run.metadata.tokenEndpoint, headers, params: body, result,
      claims: p1.tokenClaims(result.json), note: run.polls > 1 ? `${run.polls - 1} earlier poll(s) answered authorization_pending.` : null }));
    if (!result.ok) {
      if (error === 'access_denied') return deviceFinish(session, run, 'denied', { reason: 'user_denied' });
      if (error === 'expired_token') return deviceFinish(session, run, 'expired', { reason: 'timed_out' });
      return deviceFinish(session, run, 'error', { reason: typeof error === 'string' ? error.slice(0, 64) : `http_${result.status}` });
    }
    const tokens = result.json;
    if (typeof tokens?.access_token !== 'string') return deviceFinish(session, run, 'error', { reason: 'invalid_token_response' });
    let identity = null;
    if (typeof tokens.id_token === 'string') {
      const keys = await p1.jwks(run.metadata, run.traceId);
      const claims = p1.idToken(tokens.id_token, { metadata: run.metadata, keys, clientId: c.clientId });
      identity = { subject: String(claims.sub), issuer: claims.iss };
    }
    session.tokens.device = { accessToken: tokens.access_token, idToken: tokens.id_token || null, refreshToken: tokens.refresh_token || null };
    return deviceFinish(session, run, 'approved', { identity, scope: tokens.scope || null, accessToken: tokenView(tokens.access_token), idToken: tokenView(tokens.id_token) });
  }

  return { clientCredentials, refresh, introspect, revoke, userinfo, deviceStart, devicePoll };
}
