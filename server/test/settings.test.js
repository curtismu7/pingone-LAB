import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSettings, SettingsError } from '../src/settings.js';
import { tempSettingsFile } from './helpers.js';

const ENV = '00000000-0000-4000-8000-0000000000aa';
const NO_SHARED = '/nonexistent/pingone.json';
const fresh = (file = tempSettingsFile()) => createSettings({ file, sharedFile: NO_SHARED });

test('secrets are write-only: the view says set true/false, never the value', () => {
  const s = fresh();
  const view = s.update({ p1: { environmentId: ENV.toUpperCase() }, ciba: { clientId: 'c1', clientSecret: 's3cret-value-xyz' } });
  assert.deepEqual(view.settings.ciba.clientSecret, { set: true });
  assert.deepEqual(view.settings.jar.clientSecret, { set: false });
  assert.equal(view.settings.p1.environmentId, ENV, 'stored lower case');
  assert.equal(view.issuer, `https://auth.pingone.com/${ENV}/as`);
  assert.ok(!JSON.stringify(view).includes('s3cret-value-xyz'));
  assert.equal(s.liveValue('ciba', 'clientSecret'), 's3cret-value-xyz', 'the server itself can still use it');
  assert.equal(view.ready.ciba, true);
  assert.equal(view.ready.jar, false);
});

test('the region picks the auth host', () => {
  const s = fresh();
  s.update({ p1: { environmentId: ENV, region: 'eu' } });
  assert.equal(s.issuer(), `https://auth.pingone.eu/${ENV}/as`);
  assert.equal(s.authBase(), `https://auth.pingone.eu/${ENV}`);
  assert.throws(() => s.update({ p1: { region: 'evil.example' } }), SettingsError);
  assert.throws(() => s.update({ p1: { region: 'com/../x' } }), SettingsError);
});

test('the environment and region fall back to the shared .env, read only, and only those two keys', () => {
  const dir = path.dirname(tempSettingsFile());
  const shared = path.join(dir, 'shared.env');
  fs.writeFileSync(shared, `# family settings\nPINGONE_ENVIRONMENT_ID="${ENV}"\nPINGONE_REGION=NA\nWORKER_SECRET=worker-secret\nPORT=1\n`, { mode: 0o600 });
  const before = fs.readFileSync(shared, 'utf8');
  const s = createSettings({ file: path.join(dir, 'lab.json'), sharedFile: shared });
  assert.equal(s.liveValue('p1', 'environmentId'), ENV);
  assert.equal(s.liveValue('p1', 'region'), 'com');
  assert.ok(!JSON.stringify(s.publicView()).includes('worker-secret'), 'no other key is read into the view');
  s.update({ signin: { clientId: 'x' } });
  assert.equal(fs.readFileSync(shared, 'utf8'), before, 'the shared file is never written');
  // A file with no such keys is ignored, not fatal; an old pingone.json is not read at all.
  fs.writeFileSync(shared, 'SOMETHING=else\n');
  assert.equal(createSettings({ file: path.join(dir, 'lab2.json'), sharedFile: shared }).liveValue('p1', 'environmentId'), '');
  fs.writeFileSync(shared, JSON.stringify({ environmentId: ENV, region: 'com' }));
  assert.equal(createSettings({ file: path.join(dir, 'lab4.json'), sharedFile: shared }).liveValue('p1', 'environmentId'), '');
  fs.writeFileSync(shared, 'PINGONE_ENVIRONMENT_ID=not-a-uuid\nPINGONE_REGION=mars\n');
  const odd = createSettings({ file: path.join(dir, 'lab3.json'), sharedFile: shared });
  assert.equal(odd.liveValue('p1', 'environmentId'), '');
  assert.equal(odd.liveValue('p1', 'region'), 'com');
});

test('the file is mode 600 and survives a reload; a too-open file is narrowed', () => {
  const file = tempSettingsFile();
  const s = fresh(file);
  s.update({ p1: { environmentId: ENV }, signin: { clientId: 'abc', clientSecret: 'keep-me-123' } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644);
  const again = fresh(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(again.liveValue('signin', 'clientId'), 'abc');
  assert.equal(again.liveValue('signin', 'clientSecret'), 'keep-me-123');
});

test('an empty secret keeps the stored one; null clears it; empty text clears a plain field', () => {
  const s = fresh();
  s.update({ signin: { clientId: 'abc', clientSecret: 'first-secret-1' } });
  s.update({ signin: { clientSecret: '' } });
  assert.equal(s.liveValue('signin', 'clientSecret'), 'first-secret-1');
  s.update({ signin: { clientSecret: null, clientId: '' } });
  assert.equal(s.liveValue('signin', 'clientSecret'), '');
  assert.equal(s.liveValue('signin', 'clientId'), '');
});

test('validation: a UUID environment, loopback http only for the redirect, unknown fields refused, nothing half-written', () => {
  const file = tempSettingsFile();
  const s = fresh(file);
  for (const bad of ['not-a-uuid', `${ENV}/as`, `https://auth.pingone.com/${ENV}`, '../etc', '']) {
    if (bad === '') continue;
    assert.throws(() => s.update({ p1: { environmentId: bad } }), SettingsError, bad);
  }
  assert.throws(() => s.update({ p1: { redirectUri: 'http://lab.example/cb' } }), SettingsError);
  s.update({ p1: { redirectUri: 'http://localhost:5500/cb' } });
  assert.throws(() => s.update({ nope: {} }), /Unknown section/);
  assert.throws(() => s.update({ p1: { evil: 'x' } }), /Unknown field/);
  assert.throws(() => s.update(JSON.parse('{"__proto__":{"x":1}}')), SettingsError);
  assert.throws(() => s.update({ p1: JSON.parse('{"__proto__":"x"}') }), SettingsError);
  assert.throws(() => s.update({ signin: { clientId: 'has space' } }), SettingsError);
  assert.throws(() => s.update({ signin: { clientId: 'x'.repeat(600) } }), SettingsError);
  assert.throws(() => s.update({ signin: { clientSecret: 'a\nb' } }), SettingsError);
  assert.throws(() => s.update({ signin: { clientId: 7 } }), SettingsError);
  // One bad field in a patch: nothing from that patch is stored.
  assert.throws(() => s.update({ signin: { clientId: 'good' }, p1: { environmentId: 'bad' } }));
  assert.equal(fresh(file).liveValue('signin', 'clientId'), '');
});

test('defaults: the redirect URI is on the lab port, scopes have defaults, client credentials has none', () => {
  const s = fresh();
  assert.equal(s.liveValue('p1', 'redirectUri'), 'http://127.0.0.1:5500/callback');
  assert.equal(s.liveValue('p1', 'region'), 'com');
  assert.equal(s.liveValue('signin', 'scope'), 'openid profile email address phone');
  assert.equal(s.liveValue('clientCredentials', 'scope'), '');
  // Nothing configured: the lab starts in mock mode, where every card is ready against the mock.
  assert.equal(s.mode(), 'mock');
  assert.equal(s.ready('discovery'), true);
  assert.equal(s.liveIssuer(), '');
  s.setMode('live');
  assert.equal(s.ready('discovery'), false);
  assert.equal(s.issuer(), '');
});

test('mode: unset means live when an environment is configured, else mock; the mock overlay never touches live settings', () => {
  const file = tempSettingsFile();
  const s = fresh(file);
  assert.equal(s.mode(), 'mock');
  assert.match(s.issuer(), /^https:\/\/auth\.pingone-mock\.invalid\//);
  assert.equal(s.value('signin', 'clientId'), 'mock-signin');
  assert.equal(s.publicView().settings.signin.clientId, '', 'the Settings page shows the live configuration');
  s.update({ p1: { environmentId: '11111111-2222-4333-8444-555555555555' }, signin: { clientId: 'real-client' } });
  assert.equal(s.mode(), 'live', 'an environment configured and no mode chosen: live');
  assert.equal(s.value('signin', 'clientId'), 'real-client');
  s.setMode('mock');
  assert.equal(fresh(file).mode(), 'mock', 'the chosen mode is saved');
  assert.equal(fresh(file).value('signin', 'clientId'), 'mock-signin');
  assert.equal(fresh(file).liveValue('signin', 'clientId'), 'real-client');
  s.update({ signin: { scope: 'openid' } });
  assert.equal(fresh(file).mode(), 'mock', 'saving settings keeps the mode');
  assert.throws(() => s.setMode('demo'), /mode must be one of/);
});

test('hostile fields are dropped one by one; a corrupt file stops the lab and is left untouched', () => {
  const file = tempSettingsFile();
  fs.writeFileSync(file, JSON.stringify({ values: { p1: { environmentId: 'https://evil.example' }, signin: { clientId: 'ok-id' }, extra: { a: 1 } } }), { mode: 0o600 });
  const s = fresh(file);
  assert.equal(s.liveValue('p1', 'environmentId'), '');
  assert.equal(s.liveValue('signin', 'clientId'), 'ok-id');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => fresh(file), (e) => e instanceof SettingsError && e.field === 'file');
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
});
