// Rule 19: /api/info carries {source, realAvailable, realReason}; PUT /api/mode accepts mock|real,
// refuses real with 409 + reason when the live configuration is incomplete, and keeps mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';

const MOCK_ENV = { ALLOW_MOCK_SIGNIN: '1' };

test('/api/info carries the rule 19 fields; with full live settings Real is available', async () => {
  const lab = await startLab({ env: MOCK_ENV });
  try {
    const info = (await lab.call('GET', '/api/info')).data;
    assert.equal(info.source, 'real', 'an environment is configured: live by default');
    assert.equal(info.realAvailable, true);
    assert.equal(info.realReason, null);
    assert.ok(info.issuer, 'the issuer is present');
  } finally { await lab.close(); }
});

test('an incomplete live configuration: realAvailable false with the reason, and PUT real is refused 409', async () => {
  const lab = await startLab({ settings: {} });
  try {
    const info = (await lab.call('GET', '/api/info')).data;
    assert.equal(info.source, 'mock');
    assert.equal(info.realAvailable, false);
    assert.match(info.realReason, /Settings page/);
    const refused = await lab.call('PUT', '/api/mode', { mode: 'real' });
    assert.equal(refused.status, 409);
    assert.match(refused.data.message, /Settings page/);
    assert.equal((await lab.call('GET', '/api/info')).data.source, 'mock');
    const keep = await lab.call('PUT', '/api/mode', { mode: 'mock' });
    assert.equal(keep.status, 200);
    assert.equal(keep.data.source, 'mock');
  } finally { await lab.close(); }
});

test('PUT /api/mode rejects unknown modes with 400 and bad bodies with 400', async () => {
  const lab = await startLab({ env: MOCK_ENV });
  try {
    assert.equal((await lab.call('PUT', '/api/mode', { mode: 'demo' })).status, 400);
    assert.equal((await lab.call('PUT', '/api/mode', {})).status, 400);
  } finally { await lab.close(); }
});
