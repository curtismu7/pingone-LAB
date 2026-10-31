import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';
import { ENV_ID, USER } from './fakep1.js';

test('CIBA: start, pending polls, approved with a verified ID token; no auth_req_id reaches the page', async () => {
  const lab = await startLab({ fake: { cibaPolls: 3 } });
  try {
    const start = await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'alice', bindingMessage: 'PAY-42' });
    assert.equal(start.data.state, 'pending');
    assert.equal(start.data.interval, 1);
    const startStep = start.data.trace.find((s) => s.id === 'start');
    assert.match(startStep.response.body.auth_req_id, /^<redacted/);
    assert.equal(startStep.request.params.binding_message, 'PAY-42');
    let res;
    for (let i = 0; i < 10; i += 1) {
      res = await lab.call('POST', '/api/cards/ciba/poll');
      if (res.data.state !== 'pending') break;
      await new Promise((r) => setTimeout(r, 1050));
    }
    assert.equal(res.data.state, 'approved');
    assert.equal(res.data.identity.subject, USER.sub);
    assert.equal(res.data.polls, 3);
    assert.match(res.data.trace.at(-1).note, /2 earlier poll/);
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('CIBA: the page cannot poll faster than the interval', async () => {
  const lab = await startLab({ fake: { cibaPolls: 99 } });
  try {
    await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'alice' });
    for (let i = 0; i < 5; i += 1) await lab.call('POST', '/api/cards/ciba/poll');
    assert.equal(lab.fake.calls.filter((c) => c.path === `/${ENV_ID}/as/token`).length, 1);
  } finally { await lab.close(); }
});

test('CIBA: denied, unknown user, bad binding message, double start', async () => {
  const lab = await startLab({ fake: { cibaPolls: 1, cibaDecision: 'denied' } });
  try {
    assert.equal((await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'mallory' })).data.error, 'ciba_unknown_user');
    assert.equal((await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'alice', bindingMessage: 'has space' })).status, 400);
    assert.equal((await lab.call('POST', '/api/cards/ciba/start', {})).data.error, 'login_hint_required');
    await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'alice' });
    assert.equal((await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'alice' })).data.error, 'already_pending');
    const res = await lab.call('POST', '/api/cards/ciba/poll');
    assert.equal(res.data.state, 'denied');
    assert.equal((await lab.call('POST', '/api/cards/ciba/poll')).data.state, 'denied', 'the result stays readable');
  } finally { await lab.close(); }
});

test('CIBA: the signed-in user\'s username is the default login hint', async () => {
  const lab = await startLab({ fake: { cibaPolls: 1 } });
  try {
    await lab.signIn();
    const start = await lab.call('POST', '/api/cards/ciba/start', {});
    assert.equal(start.data.loginHint, 'alice');
  } finally { await lab.close(); }
});

test('CIBA: approval happens in PingOne\'s own authenticator; the lab has no approve route', async () => {
  const lab = await startLab({ fake: { cibaPolls: 99 } });
  try {
    await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'alice' });
    assert.equal((await lab.call('POST', '/api/cards/ciba/decision', { decision: 'approve' })).status, 404);
  } finally { await lab.close(); }
});
