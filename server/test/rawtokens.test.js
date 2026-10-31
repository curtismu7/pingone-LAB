import test from 'node:test';
import assert from 'node:assert/strict';
import { safeValue, safeParams, safeBody, tokenView, traceContext } from '../src/trace.js';
import { MOCK_ORIGIN, USER } from '../src/mockp1.js';
import { startLab } from './helpers.js';

// Rule 4 (owner exception 2026-10-31): a token the in-process mock issued is fake and shown whole; a live token is
// shown masked, whatever its claims say.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
// A token that CLAIMS the mock issuer but was never issued by the mock (what a live response could carry).
const forged = `${b64({ alg: 'ES256' })}.${b64({ iss: `${MOCK_ORIGIN}/env/as`, sub: 'mallory' })}.c2lnbmF0dXJlLXZhbHVlLWhlcmU`;

test('a token that only claims the mock issuer is masked everywhere the trace shows tokens, even in mock mode', () => traceContext.run({ mock: true }, () => {
  const view = tokenView(forged);
  assert.equal(view.value, undefined);
  assert.equal(view.mock, undefined);
  assert.match(view.masked, /^.{6}\.\.\..{4}$/);
  assert.deepEqual(safeValue('access_token', forged), { masked: `${forged.slice(0, 6)}...${forged.slice(-4)}`, length: forged.length, kind: 'JWT' });
  assert.ok(!JSON.stringify(safeParams(new URLSearchParams({ token: forged, subject_token: forged }))).includes(forged));
  assert.ok(!JSON.stringify(safeBody({ access_token: forged, nested: { id_token: forged } })).includes(forged));
}));

test('mock mode shows the mock tokens whole, labelled mock; secrets stay redacted', async () => {
  const lab = await startLab({ settings: null, env: { ALLOW_MOCK_SIGNIN: '1' } });
  try {
    assert.equal((await lab.call('GET', '/api/config')).data.mode, 'mock');
    const done = await lab.signIn();
    assert.equal(done.data.outcome, 'accepted');
    assert.match(done.data.accessToken.value, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(done.data.accessToken.mock, true);
    assert.equal(done.data.accessToken.masked, undefined);
    const token = done.data.trace.find((s) => s.id === 'token');
    assert.equal(token.response.body.access_token, done.data.accessToken.value, 'the trace shows the mock access token whole');
    assert.match(token.response.body.refresh_token, /^<redacted/, 'a refresh token is still a secret');
    assert.match(token.request.params.code, /^<redacted/);
    // The demo password is published on purpose (the sign-in dialog shows it); nothing else tracked may appear.
    assert.deepEqual(lab.leaks().filter((x) => x !== USER.password), [], 'no tracked secret reaches the page');
  } finally { await lab.close(); }
});

test('live mode never shows a token whole: not a forged one, and not even a mock-issued one when the lab is live', async () => {
  const live = await startLab({ mode: 'live' });
  try {
    await live.call('POST', '/api/signin/start');
    const done = await live.call('POST', '/api/signin/credentials', { username: USER.username, password: USER.password });
    assert.equal(done.data.outcome, 'accepted');
    assert.equal(done.data.accessToken.value, undefined);
    assert.match(done.data.accessToken.masked, /^.{6}\.\.\..{4}$/);
    const token = done.data.trace.find((s) => s.id === 'token');
    assert.match(token.response.body.access_token.masked, /^.{6}\.\.\..{4}$/);
  } finally { await live.close(); }

  let lab;
  // The live PingOne is stood in for by the mock, but its access tokens are swapped for a forged one that was never
  // issued by the mock, which is what a real response looks like to this process.
  const fetchImpl = async (url, init) => {
    const res = await lab.fake.fetchImpl(url, init);
    if (!String(url).endsWith('/as/token')) return res;
    const json = await res.json();
    return new Response(JSON.stringify({ ...json, access_token: forged }), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  };
  lab = await startLab({ mode: 'live', fetchImpl, env: {} });
  try {
    assert.equal((await lab.call('GET', '/api/config')).data.mode, 'live');
    const started = await lab.call('POST', '/api/signin/start');
    assert.equal(started.data.state, 'credentials_required');
    const done = await lab.call('POST', '/api/signin/credentials', { username: USER.username, password: USER.password });
    assert.equal(done.data.outcome, 'accepted');
    assert.equal(done.data.accessToken.value, undefined);
    assert.match(done.data.accessToken.masked, /^.{6}\.\.\..{4}$/);
    assert.ok(!lab.bodies.some((text) => text.includes(forged)), 'the live token never appears whole in any response');
  } finally { await lab.close(); }
});
