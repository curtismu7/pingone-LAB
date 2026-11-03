import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLab, FULL_SETTINGS } from './helpers.js';
import { USER, MOCK_ORIGIN } from '../src/mockp1.js';
import { createNetguard, selfTest, NetguardRefused } from '../src/netguard.js';
import { mockSigninRefusalFor } from '../src/app.js';

const MOCK_ENV = { ALLOW_MOCK_SIGNIN: '1' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A "real network" that records every attempt. In mock mode it must never be reached.
function network() {
  const attempts = [];
  return { attempts, fetchImpl: async (url) => { attempts.push(String(url)); throw new Error('the test network is off'); } };
}

async function pollUntilDone(lab, route) {
  let res;
  for (let i = 0; i < 10; i += 1) {
    await wait(1050);
    res = await lab.call('POST', route);
    if (res.data.state !== 'pending') break;
  }
  return res;
}

test('netguard: the self-test fails for each way a guard can be broken, so the startup check cannot rot', async () => {
  // Reaches the network (does not refuse).
  assert.deepEqual(await selfTest({ makeGuard: ({ fetchImpl }) => ({ guarded: (url, init) => fetchImpl(url, init), refusals: () => 0 }) }), { ok: false });
  // Counts the refusal and never calls fetch, but returns instead of throwing NetguardRefused.
  assert.deepEqual(await selfTest({ makeGuard: () => { let n = 0; return { guarded: async () => { n += 1; return new Response(null); }, refusals: () => n }; } }), { ok: false });
  // Throws the wrong error.
  assert.deepEqual(await selfTest({ makeGuard: () => { let n = 0; return { guarded: async () => { n += 1; throw new Error('other'); }, refusals: () => n }; } }), { ok: false });
  // Throws NetguardRefused but also lets the call through first.
  assert.deepEqual(await selfTest({ makeGuard: ({ fetchImpl }) => { let n = 0; return { guarded: async (url, init) => { n += 1; await fetchImpl(url, init); throw new NetguardRefused(url); }, refusals: () => n }; } }), { ok: false });
});

test('netguard: the self-test passes; in mock mode a real fetch is refused before it is made', async () => {
  assert.deepEqual(await selfTest(), { ok: true });
  let reached = 0;
  let mock = true;
  const guard = createNetguard({ fetchImpl: async () => { reached += 1; return new Response('ok'); }, isMock: () => mock });
  await assert.rejects(() => guard.guarded('https://auth.pingone.com/x', {}), NetguardRefused);
  assert.equal(reached, 0);
  mock = false;
  assert.equal((await guard.guarded('https://auth.pingone.com/x', {})).status, 200);
  assert.equal(guard.refusals(), 1);
});

test('mock mode with no settings file at all: every card runs end to end and the network is never touched', async () => {
  const net = network();
  const lab = await startLab({ settings: null, fetchImpl: net.fetchImpl, env: MOCK_ENV });
  try {
    const health = await lab.call('GET', '/api/health');
    assert.equal(health.data.state, 'ready');
    assert.equal(health.data.runtime, 'offline');
    const config = await lab.call('GET', '/api/config');
    assert.equal(config.data.mode, 'mock');
    assert.ok(config.data.issuer.startsWith(`${MOCK_ORIGIN}/`));
    assert.deepEqual(config.data.mockSignin, { allowed: true, username: USER.username, password: USER.password });
    const { data: { cards } } = await lab.call('GET', '/api/cards');
    assert.ok(cards.filter((c) => c.kind === 'flow' || c.ready !== undefined).every((c) => c.ready !== false), 'every card is ready in mock mode');

    const discovery = await lab.call('POST', '/api/p1/discovery');
    assert.equal(discovery.status, 200);
    assert.equal(discovery.data.trace[0].mock, true, 'a mock hop is labelled');

    // Sign-in through pi.flow with the mock's demo user; a wrong password is refused like PingOne refuses it.
    assert.equal((await lab.call('POST', '/api/signin/start')).data.state, 'credentials_required');
    const wrong = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'nope-nope-nope' });
    assert.equal(wrong.data.refused, 'credential_validation_failed');
    const signed = await lab.call('POST', '/api/signin/credentials', { username: USER.username, password: USER.password });
    assert.equal(signed.data.outcome, 'accepted');
    const me = await lab.call('GET', '/api/me');
    assert.equal(me.data.accessToken.mock, true, 'a mock-issued token is labelled');
    assert.equal(me.data.idToken.mock, true);

    const info = await lab.call('POST', '/api/cards/userinfo/read');
    assert.equal(info.data.outcome, 'accepted');
    for (const claim of ['name', 'email', 'address', 'phone_number']) assert.ok(info.data.claims.includes(claim), claim);

    for (const card of ['pkce', 'par', 'jar']) {
      const started = await lab.call('POST', `/api/cards/${card}/start`);
      const done = started.data.state === 'credentials_required'
        ? await lab.call('POST', `/api/cards/${card}/credentials`, { username: USER.username, password: USER.password })
        : started;
      assert.equal(done.data.outcome, 'accepted', `${card}: ${JSON.stringify(done.data).slice(0, 200)}`);
    }

    assert.equal((await lab.call('POST', '/api/cards/client-credentials/token')).data.outcome, 'accepted');
    assert.equal((await lab.call('POST', '/api/cards/lifecycle/refresh')).data.outcome, 'accepted');
    assert.equal((await lab.call('POST', '/api/cards/lifecycle/introspect')).data.active, true);
    assert.equal((await lab.call('POST', '/api/cards/lifecycle/revoke')).data.outcome, 'accepted');
    assert.equal((await lab.call('POST', '/api/cards/lifecycle/refresh-revoked')).data.reason, 'invalid_grant');
    const exchanged = await lab.call('POST', '/api/cards/token-exchange/run');
    assert.equal(exchanged.data.outcome, 'accepted', JSON.stringify(exchanged.data.checks));
    assert.equal(exchanged.data.token.mock, true);

    assert.equal((await lab.call('POST', '/api/cards/device/start')).data.state, 'pending');
    assert.equal((await pollUntilDone(lab, '/api/cards/device/poll')).data.state, 'approved');
    assert.equal((await lab.call('POST', '/api/cards/ciba/start', { loginHint: USER.username })).data.state, 'pending');
    assert.equal((await pollUntilDone(lab, '/api/cards/ciba/poll')).data.state, 'approved');

    assert.deepEqual(net.attempts, [], 'zero real outbound attempts in mock mode');
  } finally { await lab.close(); }
});

test('mode switch: PUT /api/mode moves the whole lab between the mock and the configured PingOne', async () => {
  const lab = await startLab({ env: MOCK_ENV });
  try {
    assert.equal((await lab.call('GET', '/api/config')).data.mode, 'live', 'an environment is configured: live by default');
    const toMock = await lab.call('PUT', '/api/mode', { mode: 'mock' });
    assert.equal(toMock.data.mode, 'mock');
    assert.equal(toMock.data.source, 'mock');
    const info = (await lab.call('GET', '/api/info')).data;
    assert.equal(info.source, 'mock');
    assert.equal(info.realAvailable, true, 'FULL_SETTINGS configures every required live value');
    await lab.call('POST', '/api/p1/discovery');
    assert.equal(lab.fake.calls.length, 0, 'mock mode never calls the configured PingOne');
    assert.equal((await lab.call('GET', '/api/settings')).data.settings.signin.clientId, FULL_SETTINGS.signin.clientId, 'live settings are untouched');
    assert.equal((await lab.call('PUT', '/api/mode', { mode: 'demo' })).status, 400);
    const cross = await lab.call('PUT', '/api/mode', { mode: 'real' }, { Origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    const back = await lab.call('PUT', '/api/mode', { mode: 'real' });
    assert.equal(back.data.mode, 'live');
    assert.equal(back.data.source, 'real');
    assert.equal((await lab.call('GET', '/api/info')).data.source, 'real');
    await lab.call('POST', '/api/p1/discovery');
    assert.ok(lab.fake.calls.length > 0, 'live mode calls the configured PingOne again');
    assert.equal((await lab.call('GET', '/api/health')).data.runtime, 'live');
  } finally { await lab.close(); }
});

test('rule 11: mock sign-in needs ALLOW_MOCK_SIGNIN=1 and is refused behind a proxy or on a non-loopback bind', async () => {
  const off = await startLab({ settings: null, env: {} });
  try {
    const res = await off.call('POST', '/api/signin/start');
    assert.equal(res.status, 403);
    assert.equal(res.data.error, 'mock_signin_refused');
    assert.equal((await off.call('POST', '/api/cards/pkce/start')).data.error, 'mock_signin_refused');
    assert.deepEqual((await off.call('GET', '/api/config')).data.mockSignin, { allowed: false }, 'no demo password is shown when sign-in is off');
  } finally { await off.close(); }
  const on = await startLab({ settings: null, env: MOCK_ENV });
  try {
    const proxied = await on.call('POST', '/api/signin/start', {}, { 'X-Forwarded-For': '203.0.113.9' });
    assert.equal(proxied.data.error, 'mock_signin_refused');
  } finally { await on.close(); }
  const req = { headers: {} };
  assert.match(mockSigninRefusalFor(req, { ALLOW_MOCK_SIGNIN: '1', LAB_BIND: '0.0.0.0' }), /beyond loopback/);
  assert.equal(mockSigninRefusalFor(req, { ALLOW_MOCK_SIGNIN: '1', LAB_BIND: '0.0.0.0', LAB_IN_CONTAINER: '1' }, () => true), null);
  // The container flag alone is not enough: the process must really be in a container.
  assert.match(mockSigninRefusalFor(req, { ALLOW_MOCK_SIGNIN: '1', LAB_BIND: '0.0.0.0', LAB_IN_CONTAINER: '1' }, () => false), /beyond loopback/);
  // NODE_ENV=production is not a guard (the Docker image sets it): the guards are the flag, the proxy and the bind.
  assert.equal(mockSigninRefusalFor(req, { ALLOW_MOCK_SIGNIN: '1', NODE_ENV: 'production' }), null);
  assert.match(mockSigninRefusalFor({ headers: { forwarded: 'for=1.2.3.4' } }, { ALLOW_MOCK_SIGNIN: '1' }), /proxy/);
  // Live mode is not mock sign-in: the guard does not apply there.
  const live = await startLab({ env: {} });
  try { assert.equal((await live.call('POST', '/api/signin/start')).data.state, 'credentials_required'); } finally { await live.close(); }
});

test('docker-compose: mock-only start needs no .env or certificate, publishes 127.0.0.1 only; the live override adds https and your settings', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  const live = fs.readFileSync(path.join(dir, 'docker-compose.live.yml'), 'utf8');
  assert.match(compose, /ALLOW_MOCK_SIGNIN: "1"/);
  assert.match(compose, /LAB_IN_CONTAINER: "1"/);
  assert.match(compose, /- "127\.0\.0\.1:5500:5500"/);
  assert.ok(!/- "5500:5500"|0\.0\.0\.0:5500|- 5500:5500/.test(compose), 'never published on all interfaces');
  assert.ok(!compose.includes(':?'), 'the mock-only form requires no variable');
  assert.ok(!/LAB_TLS_CERT:|\/tls\//.test(compose), 'no certificate in the mock-only form');
  assert.match(compose, /lab-config:\/config/, 'a named volume, so a fresh clone needs no folder');
  assert.match(compose, /http|https/, 'the health check covers http and https');
  assert.match(live, /LAB_TLS_CERT: \/tls\/cert\.pem/);
  assert.match(live, /P1LAB_TLS_CERT_FILE:\?/);
  assert.ok(!/^\s*ports:/m.test(live), 'the live override adds no published port');
});


// Rule 13: the workspace id scopes sessions, runs and traces; reset clears one workspace and no other.
test('workspaces: sessions are separate, reset clears only the named workspace, a bad id is refused', async () => {
  const lab = await startLab({ mode: 'mock', env: { ALLOW_MOCK_SIGNIN: '1' } });
  try {
    const as = (workspace, extra = {}) => ({ 'X-Lab-Workspace': workspace, ...extra });
    // Fresh cookie jar per workspace, as a browser keeps one cookie per workspace.
    const jars = {};
    const call = async (workspace, method, route, body) => {
      const res = await fetch(`${lab.base}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: lab.base, 'X-Lab-Workspace': workspace, ...(jars[workspace] ? { Cookie: jars[workspace] } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
      const set = res.headers.getSetCookie();
      if (set.length) jars[workspace] = set.map((c) => c.split(';')[0]).join('; ');
      return { status: res.status, data: await res.json().catch(() => null), set };
    };
    // Each workspace gets its own cookie name; default keeps the plain one.
    const a = await call('team-a', 'POST', '/api/cards/pkce/start', { loginHint: 'alice' });
    const d = await call('default', 'POST', '/api/cards/pkce/start', { loginHint: 'alice' });
    assert.equal(a.status, 200);
    assert.ok(a.set.some((c) => c.startsWith('p1lab_sid_team-a=')));
    assert.ok(d.set.some((c) => c.startsWith('p1lab_sid=')));
    assert.equal((await call('team-a', 'GET', '/api/config')).data.workspace, 'team-a');
    assert.equal((await call('default', 'GET', '/api/config')).data.workspace, 'default');
    // Each workspace sees only its own run.
    assert.equal((await call('team-a', 'GET', '/api/cards/pkce/result')).data.state, 'running');
    assert.equal((await call('default', 'GET', '/api/cards/pkce/result')).data.state, 'running');
    // Reset team-a: its run is gone; default's run is untouched.
    const reset = await call('team-a', 'POST', '/api/reset');
    assert.equal(reset.data.workspace, 'team-a');
    assert.equal(reset.data.sessions, 1);
    assert.equal((await call('team-a', 'GET', '/api/cards/pkce/result')).data.state, 'none');
    assert.equal((await call('default', 'GET', '/api/cards/pkce/result')).data.state, 'running');
    // One cookie never opens another workspace's session.
    const stolen = await fetch(`${lab.base}/api/cards/pkce/result`, { headers: as('team-b', { Cookie: jars.default }) });
    assert.equal((await stolen.json()).state, 'none');
    // A bad workspace id is refused.
    for (const bad of ['Team A', '../x', '-a', 'a'.repeat(33)]) {
      const res = await fetch(`${lab.base}/api/config`, { headers: as(bad) });
      assert.equal(res.status, 400, `workspace ${JSON.stringify(bad)} is refused`);
    }
  } finally { await lab.close(); }
});

test('the default tagline says what mode the lab is in; a tagline the customer wrote is never changed', async () => {
  const lab = await startLab({ mode: 'mock' });
  try {
    const mock = (await lab.call('GET', '/api/config')).data.customer.tagline;
    assert.match(mock, /simulated PingOne/);
    await lab.call('PUT', '/api/mode', { mode: 'real' });
    const live = (await lab.call('GET', '/api/config')).data.customer.tagline;
    assert.match(live, /run live against your PingOne/);
  } finally { await lab.close(); }
});

test('insideContainer: /.dockerenv or a container runtime in the cgroup of process 1', async () => {
  const { insideContainer } = await import('../src/app.js');
  assert.equal(insideContainer(() => '', (p) => p === '/.dockerenv'), true);
  assert.equal(insideContainer(() => '0::/docker/abc123', () => false), true);
  assert.equal(insideContainer(() => '0::/user.slice/session-1.scope', () => false), false);
  assert.equal(insideContainer(() => { throw new Error('no /proc'); }, () => false), false);
});

test('login_hint: a non-string is refused, and control characters and length each get their own message', async () => {
  const lab = await startLab({ settings: null, env: MOCK_ENV });
  try {
    const bad = await lab.call('POST', '/api/signin/start', { loginHint: 42 });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, 'bad_login_hint');
    assert.match(bad.data.message, /must be text/);
    const ctl = await lab.call('POST', '/api/signin/start', { loginHint: 'a\u0007b' });
    assert.match(ctl.data.message, /control characters/);
    const long = await lab.call('POST', '/api/signin/start', { loginHint: 'x'.repeat(257) });
    assert.match(long.data.message, /at most 256/);
    assert.equal((await lab.call('POST', '/api/signin/start', { loginHint: 'alice' })).status, 200);
  } finally { await lab.close(); }
});
