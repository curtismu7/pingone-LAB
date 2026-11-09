// Tests for the step-1 review fixes (one block per finding). Each would fail if its fix were reverted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startLab, tempSettingsFile, FULL_SETTINGS } from './helpers.js';
import { createFakeP1, ENV_ID, USER } from './fakep1.js';
import { htmlExcerpt, rawFlowBody } from '../src/piflow.js';
import { createOutbound, OutboundRefused } from '../src/outbound.js';
import { createEcKey, signEs256, verifyIdToken, JwtInvalid } from '../src/jose.js';
import { createSettings, SettingsError } from '../src/settings.js';
import { createApp, labAddresses } from '../src/app.js';
import { plan, ROLES } from '../../scripts/provision-p1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// 1. htmlExcerpt is linear and reads at most 8 KB.
test('htmlExcerpt: hostile bodies finish fast; only the first 8 KB is read; scripts and styles are dropped', () => {
  for (const hostile of ['<'.repeat(256 * 1024), '<script'.repeat(36000), `<style>${'<'.repeat(200000)}`, '&#'.repeat(128 * 1024), ' \t'.repeat(128 * 1024)]) {
    const started = process.hrtime.bigint();
    htmlExcerpt(hostile);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 200, `took ${ms} ms`);
  }
  assert.equal(htmlExcerpt(`<${'x'.repeat(9000)}>visible`), '', 'text beyond 8 KB is never read');
  assert.equal(htmlExcerpt('<script>steal()</script><style>p{}</style><h1>400 - Invalid client_id</h1>'), '400 - Invalid client_id');
  assert.equal(htmlExcerpt('<SCRIPT type="x">a</SCRIPT>ok &amp; done'), 'ok done');
});

test('htmlExcerpt: a huge non-JSON authorize answer does not block the server', async () => {
  const lab = await startLab({ fake: { authorizeBody: '<'.repeat(256 * 1024) } });
  try {
    const started = Date.now();
    const [res, health] = await Promise.all([lab.call('POST', '/api/signin/start'), lab.call('GET', '/api/health')]);
    assert.ok(Date.now() - started < 3000);
    assert.equal(res.data.outcome, 'refused');
    assert.equal(health.status, 200);
  } finally { await lab.close(); }
});

// 2. Sessions: no session from a GET; anonymous sessions are evicted before signed-in ones.
test('cross-site GET floods create no session and cannot evict a signed-in one', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const signedIn = lab.cookie();
    for (let i = 0; i < 250; i += 1) {
      const res = await fetch(`${lab.base}/api/me`);
      assert.equal(res.headers.get('set-cookie'), null, 'a GET never mints a session');
      await res.text();
    }
    // 250 anonymous sessions made by same-origin writes still do not push out the signed-in one.
    for (let i = 0; i < 250; i += 1) {
      const res = await fetch(`${lab.base}/api/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: lab.base }, body: '{}' });
      await res.text();
    }
    lab.setCookie(signedIn);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, true);
  } finally { await lab.close(); }
});

// 3. Session fixation: the id rotates on sign-in; a client-chosen id is never adopted.
test('sign-in rotates the session id and kills the old one; planted ids are not adopted', async () => {
  const lab = await startLab();
  try {
    await lab.call('POST', '/api/signin/start');
    const before = lab.cookie();
    const done = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: USER.password });
    assert.equal(done.data.outcome, 'accepted');
    const after = lab.cookie();
    assert.notEqual(after, before);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, true);
    lab.setCookie(before);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false, 'the pre-sign-in id is dead');
    const planted = `p1lab_sid=${'A'.repeat(43)}`;
    lab.setCookie(planted);
    const res = await lab.call('POST', '/api/reset');
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith(planted)), 'a fresh id is issued');
    assert.notEqual(lab.cookie(), planted);
  } finally { await lab.close(); }
});

test('sign-out deletes the server-side session: the old cookie is dead', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const old = lab.cookie();
    await lab.call('POST', '/api/signout');
    lab.setCookie(old);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
  } finally { await lab.close(); }
});

test('an idle session expires after 8 hours', async () => {
  let offset = 0;
  const lab = await startLab({ now: () => Date.now() + offset });
  try {
    await lab.signIn();
    offset = 7 * 60 * 60 * 1000;
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, true);
    offset += 8 * 60 * 60 * 1000 + 1000;
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
  } finally { await lab.close(); }
});

// State check and cross-issuer cookies.
test('a completed flow carrying someone else\'s state is refused', async () => {
  const lab = await startLab({ fake: { wrongState: true } });
  try {
    const res = await lab.signIn();
    assert.equal(res.data.outcome, 'failed');
    assert.equal(res.data.reason, 'state_mismatch');
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
    assert.ok(!lab.fake.calls.some((c) => c.path === `/${ENV_ID}/as/token`), 'the code is never redeemed');
  } finally { await lab.close(); }
});

test('PingOne session cookies are never sent to a different environment', async () => {
  const other = '00000000-0000-4000-8000-000000000002';
  const one = createFakeP1({ clients: { 'signin-client': { secret: 'signin-secret-value-1' }, 'pkce-client': {} } });
  const two = createFakeP1({ envId: other, clients: { 'signin-client': { secret: 'signin-secret-value-1' }, 'pkce-client': {} } });
  const route = (url, init) => (new URL(url).pathname.startsWith(`/${other}/`) ? two.fetchImpl(url, init) : one.fetchImpl(url, init));
  const lab = await startLab({ fetchImpl: route });
  try {
    assert.equal((await lab.signIn()).data.outcome, 'accepted');
    await lab.call('PUT', '/api/settings', { p1: { environmentId: other } });
    const res = await lab.call('POST', '/api/cards/pkce/start');
    assert.equal(res.data.state, 'credentials_required', 'no single sign-on across environments');
    const authorize = two.calls.find((c) => c.path === `/${other}/as/authorize`);
    assert.equal(authorize.headers.cookie, undefined);
  } finally { await lab.close(); }
});

// Settings prototype guard.
test('settings refuse __proto__ sections and do not pollute Object.prototype', () => {
  const s = createSettings({ file: tempSettingsFile() });
  assert.throws(() => s.update(JSON.parse('{"__proto__":{"toString":"x"}}')), SettingsError);
  assert.throws(() => s.update(JSON.parse('{"constructor":{"name":"x"}}')), SettingsError);
  assert.equal(typeof ({}).toString, 'function');
  assert.equal(({}).polluted, undefined);
});

// 4. Sign-in needs openid.
test('sign-in refuses a scope without openid', async () => {
  const lab = await startLab();
  try {
    await lab.call('PUT', '/api/settings', { signin: { scope: 'profile' } });
    const res = await lab.call('POST', '/api/signin/start');
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'signin_needs_openid');
    assert.equal(lab.fake.calls.length, 0);
  } finally { await lab.close(); }
});

// 5. A body that fails mid-read is a refusal, not a 500.
test('outbound: a body that errors mid-read is the same refusal as no answer', async () => {
  const broken = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a"')); c.error(new Error('ECONNRESET')); } });
  const base = `https://auth.pingone.com/${ENV_ID}`;
  const out = createOutbound({ getAuthBase: () => base, fetchImpl: async () => new Response(broken, { status: 200 }) });
  await assert.rejects(() => out.call(`${base}/as/token`), (e) => e instanceof OutboundRefused && e.reason === 'unreachable');
});

// 6. ID token claim types and ranges.
test('ID token: null payload, huge exp, future iat or nbf, non-string sub are refused (no TypeError, no 500)', async () => {
  const key = createEcKey();
  const jwks = { keys: [{ ...key.publicJwk, kid: 'k1', alg: 'ES256' }] };
  const t = Math.floor(Date.now() / 1000);
  const base = { iss: 'https://auth.example/env/as', aud: 'c1', sub: 'alice', exp: t + 60 };
  const opts = { jwks, issuer: 'https://auth.example/env/as', audience: 'c1' };
  const make = (claims) => signEs256({ alg: 'ES256', kid: 'k1' }, claims, key.privateKey);
  for (const claims of [null, [1], { ...base, exp: 1e300 }, { ...base, exp: t + 400 * 86400 }, { ...base, iat: t + 3600 }, { ...base, iat: 'now' }, { ...base, nbf: t + 3600 }, { ...base, sub: 42 }, { ...base, exp: '9' }]) {
    assert.throws(() => verifyIdToken(make(claims), opts), JwtInvalid, JSON.stringify(claims));
  }
  assert.equal(verifyIdToken(make({ ...base, iat: t, nbf: t }), opts).sub, 'alice');
  const lab = await startLab({ fake: { idTokenClaims: { exp: 8.64e15 } } });
  try {
    const res = await lab.signIn();
    assert.equal(res.status, 502);
    assert.equal(res.data.error, 'id_token_invalid');
  } finally { await lab.close(); }
});

// 9. PingOne's flow JSON is shown as it came, with the flow id, codes, tokens and secrets masked.
test('pi.flow bodies are shown raw but lose the flow id, codes, tokens and secrets', async () => {
  assert.deepEqual(rawFlowBody({ id: 'flow-123456', status: 'USERNAME_PASSWORD_REQUIRED', _links: { 'usernamePassword.check': { href: 'https://auth.example/env/flows/flow-123456' } }, _embedded: { user: { username: 'alice' } } }),
    { id: '<flow id>', status: 'USERNAME_PASSWORD_REQUIRED', _links: { 'usernamePassword.check': { href: 'https://auth.example/env/flows/<flow id>' } }, _embedded: { user: { username: 'alice' } } });
  assert.deepEqual(rawFlowBody({ code: 'VALIDATION_ERROR', details: [{ code: 'INVALID_CREDENTIALS', target: 'https://auth.example/env/flows/flow-123456' }] }, 'flow-123456'),
    { code: 'VALIDATION_ERROR', details: [{ code: 'INVALID_CREDENTIALS', target: 'https://auth.example/env/flows/<flow id>' }] });
  assert.deepEqual(rawFlowBody({ authorizeResponse: { code: 'abc', state: 's' }, sessionToken: 't', clientSecret: 'x' }),
    { authorizeResponse: { code: '<redacted>', state: 's' }, sessionToken: '<redacted>', clientSecret: '<redacted>' });
  let deep = {}; for (let i = 0; i < 50; i += 1) deep = { a: deep };
  assert.doesNotThrow(() => rawFlowBody(deep));
  assert.equal(rawFlowBody({ list: Array.from({ length: 80 }, () => 1) }).list.length, 50);
  const lab = await startLab();
  try {
    await lab.call('POST', '/api/signin/start');
    const wrong = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'nope' });
    const step = wrong.data.trace.find((s) => s.id === 'credentials');
    assert.equal(step.response.status, 400);
    assert.ok(!('id' in step.response.body) && !('_links' in step.response.body));
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

// 10. Settings: port-aware default, corrupt file, symlinks, temp file.
test('the default redirect URI follows the lab port', async () => {
  const file = tempSettingsFile();
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  server.on('request', createApp({ port, settingsFile: file, sharedFile: '/nonexistent/pingone.json', fetchImpl: async () => { throw new Error('no outbound in this test'); } }));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
    assert.equal((await res.json()).settings.p1.redirectUri, `http://127.0.0.1:${port}/callback`);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a symlinked settings file is refused for reading and writing; writes never follow a planted temp link', () => {
  const file = tempSettingsFile();
  const dir = path.dirname(file);
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'untouched');
  fs.symlinkSync(victim, file);
  assert.throws(() => createSettings({ file }), (e) => e instanceof SettingsError && e.field === 'file');
  fs.unlinkSync(file);
  const s = createSettings({ file });
  fs.symlinkSync(victim, file);
  assert.throws(() => s.update({ signin: { clientId: 'x' } }), SettingsError);
  fs.unlinkSync(file);
  // The old predictable temp name, planted as a link: the write must not go through it.
  fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
  s.update({ signin: { clientId: 'x' } });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp') && !n.includes(String(process.pid))), [], 'no temp file left behind');
});

// 12. Health behind the Host check; discovery only as a same-origin POST.
test('health is behind the Host check; a GET can never trigger discovery', async () => {
  const lab = await startLab();
  try {
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: lab.port, path: '/api/health', headers: { host: 'rebind.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(status, 403);
    assert.equal((await lab.call('GET', '/api/p1/discovery?fresh=1')).status, 404);
    assert.equal(lab.fake.calls.length, 0);
    const cross = await fetch(`${lab.base}/api/p1/discovery`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403);
    assert.equal(lab.fake.calls.length, 0);
  } finally { await lab.close(); }
});

// 12b. A local domain: LAB_ALLOWED_HOSTS adds names to the Host and Origin checks; anything else is still refused.
test('LAB_ALLOWED_HOSTS lets a named local domain in, and only that name', async () => {
  const lab = await startLab({ env: { LAB_ALLOWED_HOSTS: 'lab.local.example' } });
  try {
    const health = (host) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: lab.port, path: '/api/health', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(await health(`lab.local.example:${lab.port}`), 200);
    assert.equal(await health(`rebind.example:${lab.port}`), 403);
    const post = (origin) => fetch(`${lab.base}/api/p1/discovery`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' }).then((r) => r.status);
    assert.equal(await post(`http://lab.local.example:${lab.port}`), 200);
    assert.equal(await post(`https://lab.local.example:${lab.port}`), 403);
    assert.equal(await post('https://evil.example'), 403);
  } finally { await lab.close(); }
});

test('labAddresses: loopback always, https origins only with a certificate and key, and a bad name stops the lab', () => {
  const plain = labAddresses({ port: 5500, env: {} });
  assert.equal(plain.scheme, 'http');
  assert.deepEqual([...plain.hosts], ['127.0.0.1:5500', 'localhost:5500', '[::1]:5500']);
  const tls = labAddresses({ port: 5500, env: { LAB_TLS_CERT: '/c', LAB_TLS_KEY: '/k', LAB_ALLOWED_HOSTS: ' Lab.Local.Example , ' } });
  assert.ok(tls.origins.has('https://lab.local.example:5500'));
  assert.ok(!tls.origins.has('http://127.0.0.1:5500'));
  assert.equal(labAddresses({ port: 5500, env: { LAB_TLS_CERT: '/c' } }).scheme, 'http');
  for (const bad of ['evil.example:80', 'a b', '*.example', 'x/y', '-a.example']) {
    assert.throws(() => labAddresses({ port: 5500, env: { LAB_ALLOWED_HOSTS: bad } }), /not a host name/);
  }
});

test('the session cookie is Secure only when the lab serves https', async () => {
  const sessionCookie = async (env) => {
    const lab = await startLab({ env });
    try {
      const res = await fetch(`${lab.base}/api/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: lab.base.replace('http:', env.LAB_TLS_CERT ? 'https:' : 'http:') }, body: '{}' });
      return res.headers.getSetCookie().join('\n');
    } finally { await lab.close(); }
  };
  assert.doesNotMatch(await sessionCookie({}), /Secure/);
  assert.match(await sessionCookie({ LAB_TLS_CERT: '/c', LAB_TLS_KEY: '/k' }), /; Secure/);
});

// 13. Provision script: dry run only, own p1Lab- names, never a secret in its output.
test('provision-p1: the plan names only p1Lab- applications, with the grants each card needs', () => {
  const steps = plan({ prefix: 'p1Lab', redirectUri: 'http://127.0.0.1:5500/callback' });
  assert.deepEqual(steps.map((x) => x.role), Object.keys(ROLES));
  for (const s of steps) {
    assert.match(s.name, /^p1Lab-/);
    assert.ok(Array.isArray(s.body.grantTypes) && s.body.grantTypes.length > 0, s.name);
  }
  const signin = steps.find((x) => x.role === 'signin');
  assert.ok(signin.body.grantTypes.includes('AUTHORIZATION_CODE') && signin.body.grantTypes.includes('REFRESH_TOKEN'));
  assert.deepEqual(signin.body.redirectUris, ['http://127.0.0.1:5500/callback']);
  assert.equal(steps.find((x) => x.role === 'device').body.grantTypes[0], 'DEVICE_CODE');
  // Apps that sign a person in get the OpenID Connect scopes; machine apps do not.
  assert.deepEqual(signin.oidcScopes, ['openid', 'profile', 'email', 'address', 'phone']);
  assert.deepEqual(steps.find((x) => x.role === 'clientCredentials').oidcScopes, []);
  assert.throws(() => plan({ prefix: 'evil name', redirectUri: 'http://127.0.0.1:5500/callback' }), /prefix/);
});

test('provision-p1: the script never applies by default and never prints a secret', () => {
  const source = fs.readFileSync(path.join(here, '../../scripts/provision-p1.mjs'), 'utf8');
  assert.match(source, /--apply/);
  assert.ok(!/console\.log\([^)]*[Ss]ecret[^)]*\)/.test(source.replace(/clientSecret: '<set>'/g, '')), 'no secret in console output');
  assert.ok(!source.includes('NODE_TLS_REJECT_UNAUTHORIZED'));
});

// 12c. Behind the family lab-proxy (https://local.ping-devops.com:8443/pingone-lab/): Host is this lab's
// LAB_ALLOWED_HOSTS name, the browser's Origin is the proxy's, and the proxy says so in X-Forwarded-Host/-Proto.
test('lab-proxy: a proxied write is accepted only on an allowed Host whose forwarded origin matches the Origin', async () => {
  const name = 'pingone-lab.local.ping-devops.com';
  const proxyOrigin = 'https://local.ping-devops.com:8443';
  const lab = await startLab({ env: { LAB_ALLOWED_HOSTS: name } });
  try {
    const post = (headers) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: lab.port, path: '/api/p1/discovery', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject); req.end('{}');
    });
    const proxied = { host: `${name}:${lab.port}`, 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https' };
    // Accepted: allowed Host, forwarded headers present, Origin === proto://xfh.
    assert.equal((await post({ ...proxied, origin: proxyOrigin })).status, 200);
    // A foreign Origin is refused, and so is an Origin that does not match the forwarded host or scheme.
    for (const origin of ['https://evil.example', 'http://local.ping-devops.com:8443', 'https://local.ping-devops.com']) {
      const res = await post({ ...proxied, origin });
      assert.equal(res.status, 403, origin);
      assert.match(res.body, /cross_origin_write_refused/);
    }
    // A forwarded host that claims the attacker's origin does not help either: it must equal the Origin, and the
    // proto must be http or https.
    assert.equal((await post({ ...proxied, 'x-forwarded-proto': 'ftp', origin: 'ftp://local.ping-devops.com:8443' })).status, 403);
    assert.equal((await post({ ...proxied, 'x-forwarded-host': '', origin: 'https://' })).status, 403);
    // Forwarded headers on a loopback Host are ignored (loopback does not vouch for a proxy).
    const loopback = await post({ host: `127.0.0.1:${lab.port}`, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', origin: 'https://evil.example' });
    assert.equal(loopback.status, 403);
    assert.match(loopback.body, /cross_origin_write_refused/);
    const loopback2 = await post({ host: `localhost:${lab.port}`, 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https', origin: proxyOrigin });
    assert.equal(loopback2.status, 403);
    // A Host that is not in the set is refused before any Origin check, forwarded headers or not.
    for (const host of [`local.ping-devops.com:${lab.port}`, `evil.example:${lab.port}`, `${name}:1`]) {
      const res = await post({ ...proxied, host, origin: proxyOrigin });
      assert.equal(res.status, 403, host);
      assert.match(res.body, /host_not_allowed/);
    }
  } finally { await lab.close(); }
});

test('lab-proxy: a proxied write passes the Origin check but mock sign-in is still refused behind the proxy', async () => {
  const name = 'pingone-lab.local.ping-devops.com';
  const lab = await startLab({ settings: null, mode: 'mock', env: { LAB_ALLOWED_HOSTS: name, ALLOW_MOCK_SIGNIN: '1' } });
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: lab.port, path: '/api/signin/start', method: 'POST', headers: { 'Content-Type': 'application/json', host: `${name}:${lab.port}`, 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https', origin: 'https://local.ping-devops.com:8443' } }, (r) => {
        let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /mock_signin_refused/);
  } finally { await lab.close(); }
});

test('labAddresses: only LAB_ALLOWED_HOSTS names (never loopback) may vouch for a forwarded origin', () => {
  assert.deepEqual([...labAddresses({ port: 5500, env: {} }).proxyHosts], []);
  assert.deepEqual([...labAddresses({ port: 5500, env: { LAB_ALLOWED_HOSTS: 'pingone-lab.local.ping-devops.com' } }).proxyHosts], ['pingone-lab.local.ping-devops.com:5500']);
});
