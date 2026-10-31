import { LabError, hop } from './p1.js';
import { newTraceId, claimsOf, headerOf, tokenView } from './trace.js';

// RFC 8693 token exchange at PingOne, one hop. The signed-in user's access token (subject) is exchanged by the
// exchange application for a new token; when an actor application is set, its own client-credentials token goes in
// as actor_token, and the exchanged token's act claim should name it. PingOne builds act (and the other claims) from
// the attribute mappings of the exchange application and its resource, so every check is reported (ok true/false)
// rather than hidden: a missing act claim is a configuration lesson, not a crash.

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

const scopeSet = (value) => new Set(Array.isArray(value) ? value : String(value || '').split(/\s+/).filter(Boolean));
const hasAudience = (aud, expected) => (Array.isArray(aud) ? aud.includes(expected) : aud === expected);
const actorId = (claims) => claims?.client_id || claims?.sub || null;

// The act chain, outermost first, depth-limited.
export function actChain(claims) {
  const chain = [];
  let act = claims?.act;
  while (act && typeof act === 'object' && chain.length < 8) {
    chain.push(act.sub ?? act.client_id ?? null);
    act = act.act;
  }
  return chain;
}

export function createExchange({ p1, settings }) {
  function userToken(session) {
    const token = session.tokens.signin?.accessToken;
    if (!session.user || !token) throw new LabError('signin_required', 'Sign in with PingOne first: the exchange starts from your access token', 409);
    const claims = claimsOf(token);
    if (!claims) throw new LabError('opaque_token', 'Your PingOne access token could not be read as a JWT', 409);
    if (claims.sub === undefined || claims.sub === null || claims.sub === '') throw new LabError('no_subject', 'Your access token has no sub', 409);
    return { token, sub: String(claims.sub) };
  }

  async function actorToken({ metadata, traceId, trace }) {
    const c = settings.section('tokenExchange');
    const params = { grant_type: 'client_credentials', ...(c.actorScope ? { scope: c.actorScope } : {}) };
    const { result, body, headers } = await p1.formPost({ url: metadata.tokenEndpoint, clientId: c.actorClientId, clientSecret: c.actorClientSecret, params, traceId });
    trace.push(hop({ id: 'actor-token', title: 'The actor (an AI agent app) gets its own token', method: 'POST', url: metadata.tokenEndpoint,
      headers, params: body, result, claims: p1.tokenClaims(result.json) }));
    const token = result.json?.access_token;
    if (!result.ok || typeof token !== 'string') throw new LabError('actor_token_refused', `PingOne refused the actor token (HTTP ${result.status}${result.json?.error ? `, ${String(result.json.error).slice(0, 64)}` : ''})`, 502, { trace });
    return token;
  }

  async function run(session) {
    if (!settings.ready('tokenExchange')) throw new LabError('not_configured', 'Set the token-exchange application in Settings', 409);
    const user = userToken(session);
    const c = settings.section('tokenExchange');
    const traceId = newTraceId();
    const trace = [];
    const { metadata, step } = await p1.discover({ traceId, need: 'tokenExchange' });
    if (step) trace.push(step);
    const withActor = Boolean(c.actorClientId && c.actorClientSecret);
    const actor = withActor ? await actorToken({ metadata, traceId, trace }) : null;
    const params = {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: user.token,
      subject_token_type: ACCESS_TOKEN_TYPE,
      ...(actor ? { actor_token: actor, actor_token_type: ACCESS_TOKEN_TYPE } : {}),
      requested_token_type: ACCESS_TOKEN_TYPE,
      ...(c.scope ? { scope: c.scope } : {}),
    };
    const { result, body, headers } = await p1.formPost({ url: metadata.tokenEndpoint, clientId: c.exchangeClientId, clientSecret: c.exchangeClientSecret, params, traceId });
    trace.push(hop({ id: 'exchange', title: actor ? 'Exchange: user token + actor token -> new token' : 'Exchange: user token -> new token',
      method: 'POST', url: metadata.tokenEndpoint, headers, params: body, result, claims: p1.tokenClaims(result.json) }));
    const token = result.json?.access_token;
    if (!result.ok || typeof token !== 'string') {
      const error = typeof result.json?.error === 'string' ? result.json.error.slice(0, 64) : `http_${result.status}`;
      const out = { outcome: 'refused', reason: error, ...(typeof result.json?.error_description === 'string' ? { description: result.json.error_description.slice(0, 300) } : {}), checks: [], trace };
      session.results.tokenExchange = out;
      return out;
    }
    const claims = claimsOf(token) || {};
    const checks = [
      { name: 'is a JWT access token', ok: Boolean(claimsOf(token)) },
      { name: 'issued by the configured PingOne environment', ok: claims.iss === metadata.issuer },
      { name: 'keeps the user as subject', ok: String(claims.sub ?? '') === user.sub },
      ...(actor ? [{ name: 'act.sub names the actor', ok: Boolean(claims.act) && (claims.act.sub === actorId(claimsOf(actor)) || claims.act.client_id === actorId(claimsOf(actor))) }] : []),
      ...(c.scope ? [{ name: `scope includes ${c.scope}`, ok: [...scopeSet(c.scope)].every((s) => scopeSet(claims.scope).has(s)) }] : []),
      ...(c.audience ? [{ name: `audience is ${c.audience}`, ok: hasAudience(claims.aud, c.audience) }] : []),
    ];
    const out = {
      outcome: checks.every((x) => x.ok) ? 'accepted' : 'failed',
      token: tokenView(token),
      header: headerOf(token),
      actChain: actChain(claims),
      checks,
      trace,
    };
    session.results.tokenExchange = out;
    return out;
  }

  return { run };
}
