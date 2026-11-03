import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { startLab } from './helpers.js';

const raw = (port, { method = 'GET', path = '/api/settings', headers = {}, body } = {}) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
  if (body) req.write(body);
  req.end();
});

test('health follows demo-health/1, no detail, no outbound call', async () => {
  const lab = await startLab();
  try {
    const res = await lab.call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(res.data).sort(), ['at', 'demo', 'runtime', 'schema', 'state']);
    assert.equal(res.data.schema, 'demo-health/1');
    assert.equal(res.data.state, 'ready');
    assert.equal(res.data.runtime, 'live');
    assert.deepEqual(res.data.demo, { id: 'pingone-lab', name: 'PingOne Lab', version: '0.1.0' });
    assert.ok(res.text.length < 4096);
    assert.equal(lab.fake.calls.length, 0);
  } finally { await lab.close(); }
  const empty = await startLab({ settings: null, mode: 'live' });
  try { assert.equal((await empty.call('GET', '/api/health')).data.state, 'needs-setup'); } finally { await empty.close(); }
});

test('Host check, same-origin writes and JSON-only writes', async () => {
  const lab = await startLab();
  try {
    assert.equal(await raw(lab.port, { headers: { host: 'evil.example' } }), 403);
    assert.equal(await raw(lab.port, { headers: { host: `127.0.0.1:${lab.port}` } }), 200);
    assert.equal(await raw(lab.port, { headers: { host: `localhost:${lab.port}` } }), 200);
    const write = (headers) => raw(lab.port, { method: 'POST', path: '/api/reset', headers: { host: `127.0.0.1:${lab.port}`, 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal(await write({ origin: 'https://evil.example' }), 403);
    assert.equal(await write({ origin: `http://127.0.0.1:${lab.port + 1}` }), 403);
    assert.equal(await write({ 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(await write({ origin: `http://127.0.0.1:${lab.port}` }), 200);
    assert.equal(await raw(lab.port, { method: 'POST', path: '/api/reset', headers: { host: `127.0.0.1:${lab.port}`, 'content-type': 'text/plain' }, body: '{}' }), 415);
    assert.equal(await raw(lab.port, { method: 'POST', path: '/api/reset', headers: { host: `127.0.0.1:${lab.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' }), 415);
  } finally { await lab.close(); }
});

test('settings API: secrets write-only, validation errors are JSON, file stays 600', async () => {
  const lab = await startLab();
  try {
    const view = await lab.call('GET', '/api/settings');
    assert.deepEqual(view.data.settings.ciba.clientSecret, { set: true });
    assert.ok(!view.text.includes('ciba-secret-value-1'));
    const put = await lab.call('PUT', '/api/settings', { ciba: { clientSecret: 'brand-new-secret-9' } });
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes('brand-new-secret-9'));
    assert.equal(fs.statSync(lab.file).mode & 0o777, 0o600);
    const bad = await lab.call('PUT', '/api/settings', { p1: { environmentId: 'https://evil.example' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, 'invalid_setting');
    assert.equal(bad.data.field, 'p1.environmentId');
    const huge = await lab.call('PUT', '/api/settings', { p1: { environmentId: 'a'.repeat(20000) } });
    assert.equal(huge.status, 413);
    const notJson = await fetch(`${lab.base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(notJson.status, 400);
    assert.deepEqual(await notJson.json(), { error: 'bad_request' });
  } finally { await lab.close(); }
});

test('cards list: ready flags; advertised is unknown until PingOne was read, then true', async () => {
  const lab = await startLab();
  try {
    let { data } = await lab.call('GET', '/api/cards');
    const ids = ['discovery', 'signin', 'pkce', 'par', 'jar', 'clientCredentials', 'lifecycle', 'userinfo', 'device', 'ciba', 'tokenExchange'];
    for (const id of ids) assert.equal(data.cards.find((c) => c.id === id).ready, true, id);
    assert.equal(data.cards.find((c) => c.id === 'par').advertised, null);
    assert.equal(lab.fake.calls.length, 0, 'the card list never calls PingOne');
    await lab.call('POST', '/api/p1/discovery');
    ({ data } = await lab.call('GET', '/api/cards'));
    for (const id of ids.filter((x) => x !== 'discovery')) assert.equal(data.cards.find((c) => c.id === id).advertised, true, id);
  } finally { await lab.close(); }
  const empty = await startLab({ settings: null, mode: 'live' });
  try {
    const { data } = await empty.call('GET', '/api/cards');
    assert.ok(data.cards.every((c) => c.ready === false));
    for (const route of ['/api/signin/start', '/api/cards/pkce/start', '/api/cards/device/start', '/api/cards/client-credentials/token', '/api/cards/ciba/start', '/api/cards/token-exchange/run']) {
      const start = await empty.call('POST', route, {});
      assert.equal(start.status, 409, route);
      assert.equal(start.data.error, 'not_configured', route);
    }
    assert.equal(empty.fake.calls.length, 0, 'nothing configured: nothing called');
  } finally { await empty.close(); }
});

test('unknown routes and cards are JSON 404s', async () => {
  const lab = await startLab();
  try {
    assert.equal((await lab.call('GET', '/nope')).data.error, 'not_found');
    assert.equal((await lab.call('POST', '/api/cards/evil/start')).status, 404);
    assert.equal((await lab.call('POST', '/api/cards/__proto__/start')).status, 404);
    assert.equal((await lab.call('POST', '/api/cards/constructor/start')).status, 404);
    assert.equal((await lab.call('POST', '/api/cards/toString/credentials')).status, 404);
    assert.equal((await lab.call('POST', '/api/cards/rar/start')).status, 404, 'no RAR: PingOne does not advertise it');
    assert.equal((await lab.call('POST', '/api/cards/dpop/start')).status, 404, 'no DPoP: PingOne does not advertise it');
  } finally { await lab.close(); }
});
