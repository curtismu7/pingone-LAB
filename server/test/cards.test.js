import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';
import { ENV_ID, ISSUER, ORIGIN, USER } from './fakep1.js';

test('discovery check lists what PingOne advertises, including what it does not (DPoP, RAR, DCR)', async () => {
  const lab = await startLab();
  try {
    const res = await lab.call('POST', '/api/p1/discovery');
    assert.equal(res.status, 200);
    assert.equal(res.data.issuer, ISSUER);
    const f = Object.fromEntries(res.data.features.map((x) => [x.id, x.supported]));
    assert.deepEqual(f, {
      piflow: true, pkce: true, par: true, jar: true, requestUri: false, clientCredentials: true, refresh: true, introspection: true,
      revocation: true, userinfo: true, device: true, ciba: true, tokenExchange: true, dpop: false, rar: false, dcr: false,
    });
    assert.equal(res.data.trace[0].request.url, `${ISSUER}/.well-known/openid-configuration`);
  } finally { await lab.close(); }
});

test('discovery is refused when the issuer differs or an endpoint leaves the environment', async () => {
  for (const [discovery, code] of [
    [{ issuer: 'https://other.example/as' }, 'discovery_issuer_mismatch'],
    [{ token_endpoint: 'https://evil.example/token' }, 'discovery_invalid'],
    [{ token_endpoint: `${ORIGIN}/00000000-0000-4000-8000-000000000009/as/token` }, 'discovery_invalid'],
    [{ pushed_authorization_request_endpoint: `http://auth.pingone.com/${ENV_ID}/as/par` }, 'discovery_invalid'],
    [{ jwks_uri: undefined }, 'discovery_invalid'],
  ]) {
    const lab = await startLab({ fake: { discovery } });
    try {
      const res = await lab.call('POST', '/api/p1/discovery');
      assert.equal(res.status, 502);
      assert.equal(res.data.error, code);
      assert.ok(Array.isArray(res.data.trace), 'the trace up to the failure is shown');
      assert.ok(lab.fake.calls.every((c) => c.origin === ORIGIN));
    } finally { await lab.close(); }
  }
});

test('a card this PingOne does not advertise is refused before anything else is called', async () => {
  for (const [card, route, discovery] of [
    ['par', '/api/cards/par/start', { pushed_authorization_request_endpoint: undefined }],
    ['jar', '/api/cards/jar/start', { request_object_signing_alg_values_supported: ['RS256'] }],
    ['device', '/api/cards/device/start', { device_authorization_endpoint: undefined }],
    ['ciba', '/api/cards/ciba/start', { backchannel_token_delivery_modes_supported: ['ping'] }],
    ['clientCredentials', '/api/cards/client-credentials/token', { grant_types_supported: ['authorization_code'] }],
    ['signin', '/api/signin/start', { response_modes_supported: ['query'] }],
  ]) {
    const lab = await startLab({ fake: { discovery } });
    try {
      const res = await lab.call('POST', route, card === 'ciba' ? { loginHint: 'alice' } : {});
      assert.equal(res.status, 409, card);
      assert.equal(res.data.error, 'not_advertised', card);
      assert.deepEqual(lab.fake.calls.map((c) => c.path), [`/${ENV_ID}/as/.well-known/openid-configuration`], `${card}: only discovery was called`);
      const cards = await lab.call('GET', '/api/cards');
      assert.equal(cards.data.cards.find((c) => c.id === card).advertised, false, card);
    } finally { await lab.close(); }
  }
});

test('PKCE card: S256 challenge in the request, verifier at the token endpoint (redacted in the trace)', async () => {
  const lab = await startLab();
  try {
    const started = await lab.call('POST', '/api/cards/pkce/start');
    assert.equal(started.data.state, 'credentials_required');
    const done = await lab.call('POST', '/api/cards/pkce/credentials', { username: 'alice', password: USER.password });
    assert.equal(done.data.outcome, 'accepted');
    const authorize = done.data.trace.find((s) => s.id === 'authorize');
    assert.equal(authorize.request.params.code_challenge_method, 'S256');
    assert.equal(authorize.request.params.response_mode, 'pi.flow');
    const token = done.data.trace.find((s) => s.id === 'token');
    assert.match(token.request.params.code_verifier, /^<redacted/);
    assert.match(token.request.params.code, /^<redacted/);
    assert.equal((await lab.call('GET', '/api/cards/pkce/result')).data.outcome, 'accepted');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('login_hint: sent when a user is given, echoed for the sign-in form, bounded', async () => {
  const lab = await startLab();
  try {
    const plain = await lab.call('POST', '/api/cards/pkce/start');
    assert.equal(plain.data.trace.find((s) => s.id === 'authorize').request.params.login_hint, undefined);
    assert.equal(plain.data.loginHint, undefined);
    const hinted = await lab.call('POST', '/api/cards/pkce/start', { loginHint: ' alice ' });
    assert.equal(hinted.data.trace.find((s) => s.id === 'authorize').request.params.login_hint, 'alice');
    assert.equal(hinted.data.loginHint, 'alice');
    const signin = await lab.call('POST', '/api/signin/start', { loginHint: 'alice' });
    assert.equal(signin.data.trace.find((s) => s.id === 'authorize').request.params.login_hint, 'alice');
    const par = await lab.call('POST', '/api/cards/par/start', { loginHint: 'alice' });
    assert.equal(par.data.trace.find((s) => s.id === 'par').request.params.login_hint, 'alice');
    const jar = await lab.call('POST', '/api/cards/jar/start', { loginHint: 'alice' });
    assert.equal(jar.data.trace.find((s) => s.id === 'request-object').request.body.claims.login_hint, 'alice');
    assert.equal((await lab.call('POST', '/api/cards/pkce/start', { loginHint: 'a\nb' })).data.error, 'bad_login_hint');
    assert.equal((await lab.call('POST', '/api/cards/pkce/start', { loginHint: 'x'.repeat(257) })).data.error, 'bad_login_hint');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('PAR card: pushed request, then only client_id + request_uri on the authorization request', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const res = await lab.call('POST', '/api/cards/par/start');
    assert.equal(res.data.outcome, 'accepted');
    const par = res.data.trace.find((s) => s.id === 'par');
    assert.equal(par.response.status, 201);
    assert.match(par.response.body.request_uri, /^urn:ietf:params:oauth:request_uri:.{8}\.\.\.$/);
    assert.equal(par.request.headers.Authorization, 'Basic <redacted>');
    const authorize = res.data.trace.find((s) => s.id === 'authorize');
    assert.deepEqual(Object.keys(authorize.request.params).sort(), ['client_id', 'request_uri', 'response_mode']);
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('JAR card: parameters travel inside an HS256 request object; PingOne verifies it; the secret never shows', async () => {
  const lab = await startLab();
  try {
    const started = await lab.call('POST', '/api/cards/jar/start');
    assert.equal(started.data.state, 'credentials_required');
    const obj = started.data.trace.find((s) => s.id === 'request-object');
    assert.equal(obj.request.body.header.alg, 'HS256');
    assert.equal(obj.request.body.claims.iss, 'jar-client');
    assert.equal(obj.request.body.claims.aud, ISSUER);
    assert.equal(obj.request.body.claims.response_mode, 'pi.flow');
    const authorize = started.data.trace.find((s) => s.id === 'authorize');
    assert.deepEqual(Object.keys(authorize.request.params).sort(), ['client_id', 'request', 'response_mode', 'response_type', 'scope']);
    assert.equal(authorize.request.params.request.kind, 'JWT', 'the request object is shown masked');
    const done = await lab.call('POST', '/api/cards/jar/credentials', { username: 'alice', password: USER.password });
    assert.equal(done.data.outcome, 'accepted');
    assert.ok(!JSON.stringify(done.data).includes('jar-secret-value-1'));
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('JAR card: a request object signed with the wrong secret is refused by PingOne (expected refusal)', async () => {
  const lab = await startLab();
  try {
    await lab.call('PUT', '/api/settings', { jar: { clientSecret: 'not-the-real-secret' } });
    const res = await lab.call('POST', '/api/cards/jar/start');
    assert.equal(res.data.outcome, 'refused');
    assert.equal(res.data.reason, 'invalid_request_object');
  } finally { await lab.close(); }
});

test('client credentials: a token for the application, with no user; a scope it lacks is refused', async () => {
  const lab = await startLab();
  try {
    const ok = await lab.call('POST', '/api/cards/client-credentials/token');
    assert.equal(ok.data.outcome, 'accepted');
    assert.equal(ok.data.accessToken.claims.client_id, 'cc-client');
    assert.equal(ok.data.accessToken.claims.sub, undefined);
    assert.equal(ok.data.trace.at(-1).request.params.grant_type, 'client_credentials');
    await lab.call('PUT', '/api/settings', { clientCredentials: { scope: 'admin:everything' } });
    const refused = await lab.call('POST', '/api/cards/client-credentials/token');
    assert.equal(refused.data.outcome, 'refused');
    assert.equal(refused.data.reason, 'invalid_scope');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('lifecycle: refresh, introspect (active), revoke, then the revoked refresh token is refused', async () => {
  const lab = await startLab();
  try {
    assert.equal((await lab.call('POST', '/api/cards/lifecycle/refresh')).data.error, 'signin_required');
    await lab.signIn();
    const refreshed = await lab.call('POST', '/api/cards/lifecycle/refresh');
    assert.equal(refreshed.data.outcome, 'accepted');
    assert.equal(refreshed.data.rotated, true);
    const intro = await lab.call('POST', '/api/cards/lifecycle/introspect');
    assert.equal(intro.data.outcome, 'accepted');
    assert.equal(intro.data.active, true);
    assert.equal(intro.data.trace.at(-1).request.params.token.kind, 'JWT', 'the token sent is masked');
    const revoked = await lab.call('POST', '/api/cards/lifecycle/revoke');
    assert.equal(revoked.data.outcome, 'accepted');
    assert.match(revoked.data.trace.at(-1).request.params.token, /^<redacted/, 'the refresh token sent is redacted');
    const after = await lab.call('POST', '/api/cards/lifecycle/refresh-revoked');
    assert.equal(after.data.outcome, 'refused');
    assert.equal(after.data.reason, 'invalid_grant');
    assert.equal(after.data.trace.at(-1).id, 'refresh-revoked');
    assert.deepEqual(after.data.trace.map((x) => x.id).filter((x) => x !== 'discovery'), ['refresh', 'introspect', 'revoke', 'refresh-revoked'], 'one chained run');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('lifecycle without a refresh token says how to fix it', async () => {
  const lab = await startLab({ fake: { noRefresh: true } });
  try {
    await lab.signIn();
    const res = await lab.call('POST', '/api/cards/lifecycle/refresh');
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'no_refresh_token');
  } finally { await lab.close(); }
});

test('userinfo: read with the signed-in token; sub matches the ID token', async () => {
  const lab = await startLab();
  try {
    assert.equal((await lab.call('POST', '/api/cards/userinfo/read')).data.error, 'signin_required');
    await lab.signIn();
    const res = await lab.call('POST', '/api/cards/userinfo/read');
    assert.equal(res.data.outcome, 'accepted');
    assert.equal(res.data.subMatches, true);
    assert.ok(res.data.claims.includes('preferred_username'));
    assert.equal(res.data.trace.at(-1).request.headers.Authorization, 'Bearer <redacted>');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('device authorization: user code and PingOne verification link, pending polls, then tokens; the device code never shows', async () => {
  const lab = await startLab({ fake: { devicePolls: 2 } });
  try {
    const started = await lab.call('POST', '/api/cards/device/start');
    assert.equal(started.data.state, 'pending');
    assert.equal(started.data.userCode, 'WDJB-MJHT');
    assert.equal(started.data.verificationUri, `${ORIGIN}/${ENV_ID}/device`);
    assert.match(started.data.verificationUriComplete, /user_code=WDJB-MJHT$/);
    let res = started;
    for (let i = 0; i < 20 && res.data.state === 'pending'; i += 1) {
      await new Promise((r) => setTimeout(r, 1050));
      res = await lab.call('POST', '/api/cards/device/poll');
    }
    assert.equal(res.data.state, 'approved');
    assert.equal(res.data.identity.subject, USER.sub);
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('device authorization: a verification link off this PingOne is not shown; denied ends the run', async () => {
  const lab = await startLab({ fake: { verificationUri: 'https://phish.example/device', devicePolls: 1, deviceDecision: 'denied' } });
  try {
    const started = await lab.call('POST', '/api/cards/device/start');
    assert.equal(started.data.verificationUri, null);
    assert.equal(started.data.verificationUriComplete, null);
    const res = await lab.call('POST', '/api/cards/device/poll');
    assert.equal(res.data.state, 'denied');
  } finally { await lab.close(); }
});

test('Reset clears card results but keeps the sign-in', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    await lab.call('POST', '/api/cards/pkce/start');
    const reset = await lab.call('POST', '/api/reset');
    assert.equal(reset.data.ok, true);
    assert.equal((await lab.call('GET', '/api/cards/pkce/result')).data.state, 'none');
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, true);
    assert.equal((await lab.call('POST', '/api/cards/userinfo/read')).data.outcome, 'accepted', 'the sign-in tokens are kept');
  } finally { await lab.close(); }
});
