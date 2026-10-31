import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';
import { ORIGIN, ENV_ID, USER } from './fakep1.js';

const credentialCall = (lab) => lab.fake.calls.find((c) => c.path.startsWith(`/${ENV_ID}/flows/`) && c.method === 'POST');

test('pi.flow sign-in: JSON flow, password posted to the flows API, code from resume, redeemed with PKCE, tokens kept server-side', async () => {
  const lab = await startLab();
  try {
    const started = await lab.call('POST', '/api/signin/start');
    assert.equal(started.status, 200);
    assert.equal(started.data.state, 'credentials_required');
    assert.equal(started.data.status, 'USERNAME_PASSWORD_REQUIRED');
    const done = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: USER.password });
    assert.equal(done.data.outcome, 'accepted');
    assert.equal(done.data.identity.subject, USER.sub);
    assert.equal(done.data.identity.username, 'alice');
    assert.equal(done.data.accessToken.kind, 'JWT');
    assert.equal(done.data.refreshToken, true);
    assert.match(done.data.accessToken.masked, /^.{6}\.\.\..{4}$/);
    assert.deepEqual(done.data.trace.map((s) => s.id), ['discovery', 'authorize', 'credentials', 'resume', 'token']);

    // What PingOne saw: response_mode=pi.flow as JSON, the ST cookie replayed, the usernamePassword.check type,
    // resume with the flow id, PKCE at the token endpoint.
    const authorize = lab.fake.calls.find((c) => c.path === `/${ENV_ID}/as/authorize`);
    assert.match(authorize.headers.accept, /application\/json/);
    const step = credentialCall(lab);
    assert.equal(step.headers['content-type'], 'application/vnd.pingidentity.usernamePassword.check+json');
    assert.match(step.headers.cookie, /ST=/);
    assert.ok(lab.fake.calls.some((c) => c.path === `/${ENV_ID}/as/resume`));
    assert.ok(lab.fake.calls.every((c) => c.origin === ORIGIN && c.path.startsWith(`/${ENV_ID}/`)), 'only the configured environment was called');
    assert.ok(lab.fake.calls.every((c) => /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(c.headers.traceparent)), 'traceparent on every hop');
    assert.ok(lab.fake.calls.every((c) => c.redirect === 'manual'), 'redirects never followed');
    const traceIds = new Set(lab.fake.calls.map((c) => c.headers.traceparent.split('-')[1]));
    assert.equal(traceIds.size, 1, 'one trace id for the run');

    const me = await lab.call('GET', '/api/me');
    assert.equal(me.data.signedIn, true);
    assert.equal(me.data.user.subject, USER.sub);
    assert.equal(me.data.accessToken.claims.sub, USER.sub);
    assert.deepEqual(lab.leaks(), [], 'no code, verifier, token, cookie, flow id or password reached the page');
    assert.ok(!JSON.stringify(done.data.trace).includes(USER.password));
  } finally { await lab.close(); }
});

test('identifier-first policy: SIGN_ON_REQUIRED takes user.lookup, then the password', async () => {
  const lab = await startLab({ fake: { identifierFirst: true } });
  try {
    const started = await lab.call('POST', '/api/signin/start');
    assert.equal(started.data.state, 'credentials_required');
    assert.equal(started.data.status, 'SIGN_ON_REQUIRED');
    const done = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: USER.password });
    assert.equal(done.data.outcome, 'accepted');
    assert.deepEqual(done.data.trace.map((s) => s.id), ['discovery', 'authorize', 'lookup', 'credentials', 'resume', 'token']);
    const types = lab.fake.calls.filter((c) => c.path.startsWith(`/${ENV_ID}/flows/`)).map((c) => c.headers['content-type']);
    assert.deepEqual(types, ['application/vnd.pingidentity.user.lookup+json', 'application/vnd.pingidentity.usernamePassword.check+json']);
  } finally { await lab.close(); }
});

test('resume answered with a redirect: the code is read from Location, never followed, never shown', async () => {
  const lab = await startLab({ fake: { resumeMode: 'redirect' } });
  try {
    const done = await lab.signIn();
    assert.equal(done.data.outcome, 'accepted');
    const resume = done.data.trace.find((s) => s.id === 'resume');
    assert.equal(resume.response.status, 302);
    assert.match(resume.response.body.authorizeResponse.code, /^<redacted/);
    assert.ok(!('location' in resume.response) || !String(resume.response.location).includes('code='));
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('a state that does not match is refused', async () => {
  const lab = await startLab({ fake: { wrongState: true } });
  try {
    const done = await lab.signIn();
    assert.equal(done.data.outcome, 'failed');
    assert.equal(done.data.reason, 'state_mismatch');
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
  } finally { await lab.close(); }
});

test('a wrong password is refused (INVALID_CREDENTIALS) and the same flow takes the right one', async () => {
  const lab = await startLab();
  try {
    await lab.call('POST', '/api/signin/start');
    const wrong = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'nope' });
    assert.equal(wrong.data.state, 'credentials_required');
    assert.equal(wrong.data.refused, 'credential_validation_failed');
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
    const right = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: USER.password });
    assert.equal(right.data.outcome, 'accepted');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('a policy that asks for MFA stops the run at that status (this lab drives passwords only)', async () => {
  const lab = await startLab({ fake: { mfa: true } });
  try {
    await lab.call('POST', '/api/signin/start');
    const res = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: USER.password });
    assert.equal(res.data.state, 'stopped');
    assert.equal(res.data.status, 'MFA_REQUIRED');
  } finally { await lab.close(); }
});

test('a flow PingOne no longer knows (expired) ends the run as flow_gone', async () => {
  const lab = await startLab();
  try {
    await lab.call('POST', '/api/signin/start');
    lab.fake.forgetFlows();
    const gone = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: USER.password });
    assert.equal(gone.data.outcome, 'failed');
    assert.equal(gone.data.reason, 'flow_gone');
    assert.equal(gone.data.trace.at(-1).response.status, 404);
    assert.equal((await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'x' })).data.error, 'no_run');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('credential input is bounded and needs a started run', async () => {
  const lab = await startLab();
  try {
    assert.equal((await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'x' })).data.error, 'no_run');
    await lab.call('POST', '/api/signin/start');
    for (const body of [{ username: '', password: 'x' }, { username: 'a\nb', password: 'x' }, { username: 'alice' }, { username: ['a'], password: 'x' }, { username: 'alice', password: 'p'.repeat(2000) }]) {
      assert.equal((await lab.call('POST', '/api/signin/credentials', body)).status, 400, JSON.stringify(body).slice(0, 40));
    }
  } finally { await lab.close(); }
});

test('after sign-in, a later run rides the PingOne session (SSO) and needs no password', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const pkce = await lab.call('POST', '/api/cards/pkce/start');
    assert.equal(pkce.data.outcome, 'accepted');
    assert.ok(!pkce.data.trace.some((s) => s.id === 'credentials'));
  } finally { await lab.close(); }
});

test('sign-out drops the session and everything in it', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const out = await lab.call('POST', '/api/signout');
    assert.match(out.headers.get('set-cookie'), /p1lab_sid=; .*Max-Age=0/);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
  } finally { await lab.close(); }
});

test('the session cookie is HttpOnly and SameSite=Strict; sessions do not mix', async () => {
  const a = await startLab();
  try {
    const first = await a.call('POST', '/api/reset');
    assert.match(first.headers.get('set-cookie'), /^p1lab_sid=.*HttpOnly; SameSite=Strict/);
    await a.signIn();
    const stranger = await fetch(`${a.base}/api/me`);
    assert.equal((await stranger.json()).signedIn, false);
    const forged = await fetch(`${a.base}/api/me`, { headers: { Cookie: 'p1lab_sid=../../etc' } });
    assert.equal((await forged.json()).signedIn, false);
  } finally { await a.close(); }
});

test('pi.flow open-and-read: shows status, sends no credential and no session cookie, never shows the flow id', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const before = lab.fake.calls.length;
    const res = await lab.call('POST', '/api/cards/piflow/open');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'USERNAME_PASSWORD_REQUIRED');
    const calls = lab.fake.calls.slice(before);
    assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET']);
    assert.ok(!/(^|; )ST=/.test(calls[0].headers.cookie || ''), 'fresh flow: the sign-in session cookie is not sent');
    assert.ok(res.data.trace.every((s) => !JSON.stringify(s).match(/flows\/[A-Za-z0-9_-]{6,}/)), 'flow id never shown');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('a refused authorization request is shown as a refusal with PingOne\'s error', async () => {
  const lab = await startLab();
  try {
    await lab.call('PUT', '/api/settings', { signin: { clientId: 'unknown-client' } });
    const res = await lab.call('POST', '/api/signin/start');
    assert.equal(res.data.outcome, 'refused');
    assert.equal(res.data.reason, 'invalid_client');
  } finally { await lab.close(); }
});
