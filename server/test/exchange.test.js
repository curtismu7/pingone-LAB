import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab, FULL_SETTINGS } from './helpers.js';
import { USER } from './fakep1.js';
import { actChain } from '../src/exchange.js';

test('token exchange needs a PingOne sign-in', async () => {
  const lab = await startLab();
  try {
    const res = await lab.call('POST', '/api/cards/token-exchange/run');
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'signin_required');
  } finally { await lab.close(); }
});

test('with an actor: user token + actor token -> new token for the same user, act.sub = actor', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const res = await lab.call('POST', '/api/cards/token-exchange/run');
    assert.equal(res.data.outcome, 'accepted', JSON.stringify(res.data.checks));
    assert.deepEqual(res.data.actChain, ['actor-client']);
    assert.equal(res.data.token.claims.sub, USER.sub);
    const ex = res.data.trace.find((s) => s.id === 'exchange');
    assert.equal(ex.request.params.grant_type, 'urn:ietf:params:oauth:grant-type:token-exchange');
    assert.equal(ex.request.params.subject_token.kind, 'JWT');
    assert.equal(ex.request.params.actor_token.kind, 'JWT');
    assert.ok(res.data.trace.some((s) => s.id === 'actor-token'));
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('without an actor: one call, no actor_token, no act check', async () => {
  const settings = structuredClone(FULL_SETTINGS);
  delete settings.tokenExchange.actorClientId;
  delete settings.tokenExchange.actorClientSecret;
  const lab = await startLab({ settings });
  try {
    await lab.signIn();
    const res = await lab.call('POST', '/api/cards/token-exchange/run');
    assert.equal(res.data.outcome, 'accepted');
    assert.ok(!res.data.trace.some((s) => s.id === 'actor-token'));
    assert.equal(res.data.trace.find((s) => s.id === 'exchange').request.params.actor_token, undefined);
    assert.ok(!res.data.checks.some((c) => c.name.startsWith('act')));
  } finally { await lab.close(); }
});

test('a token without act (PingOne mapping not set) is reported as a failed check, not hidden', async () => {
  const lab = await startLab({ fake: { noAct: true } });
  try {
    await lab.signIn();
    const res = await lab.call('POST', '/api/cards/token-exchange/run');
    assert.equal(res.data.outcome, 'failed');
    assert.deepEqual(res.data.checks.filter((c) => !c.ok).map((c) => c.name), ['act.sub names the actor']);
  } finally { await lab.close(); }
});

test('a configured audience is checked; a refusal keeps PingOne\'s words', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    await lab.call('PUT', '/api/settings', { tokenExchange: { audience: 'https://mcp.example' } });
    const res = await lab.call('POST', '/api/cards/token-exchange/run');
    assert.equal(res.data.outcome, 'failed');
    assert.ok(res.data.checks.some((c) => c.name === 'audience is https://mcp.example' && !c.ok));
    await lab.call('PUT', '/api/settings', { tokenExchange: { exchangeClientSecret: 'wrong-secret-value' } });
    const refused = await lab.call('POST', '/api/cards/token-exchange/run');
    assert.equal(refused.data.outcome, 'refused');
    assert.equal(refused.data.reason, 'invalid_client');
  } finally { await lab.close(); }
});

test('actChain walks at most 8 levels', () => {
  let claims = { act: { sub: 'a0' } };
  let cursor = claims.act;
  for (let i = 1; i < 20; i += 1) { cursor.act = { sub: `a${i}` }; cursor = cursor.act; }
  assert.equal(actChain(claims).length, 8);
});
