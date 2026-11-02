import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostRunMockSignin, mockSigninRefusalFor } from '../src/app.js';

// Plain `npm start` (host-run): mock sign-in turns itself on only for loopback with no tenant and no explicit choice.
test('hostRunMockSignin: loopback, no tenant and no choice turns it on; everything else leaves it alone', () => {
  const on = { env: {}, bind: '127.0.0.1', tenantConfigured: false };
  assert.equal(hostRunMockSignin(on), true);
  assert.equal(hostRunMockSignin({ ...on, env: { NODE_ENV: 'production' } }), true, 'NODE_ENV is not a guard either way');
  assert.equal(hostRunMockSignin({ ...on, env: { ALLOW_MOCK_SIGNIN: '0' } }), false, 'an explicit 0 is respected');
  assert.equal(hostRunMockSignin({ ...on, env: { ALLOW_MOCK_SIGNIN: '1' } }), false, 'already on: nothing to set');
  assert.equal(hostRunMockSignin({ ...on, bind: '0.0.0.0' }), false, 'a bind beyond loopback never defaults on');
  assert.equal(hostRunMockSignin({ ...on, tenantConfigured: true }), false, 'a configured PingOne environment never defaults on');
});

test('host-run start: loopback with no settings allows mock sign-in; a proxy header and a wide bind still refuse it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1lab-hr-'));
  const index = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');
  const env = { ...process.env, PORT: '5542', P1LAB_SETTINGS_FILE: path.join(dir, 'p1.json'), P1LAB_SHARED_FILE: path.join(dir, 'none.json') };
  delete env.ALLOW_MOCK_SIGNIN;
  delete env.LAB_BIND;
  const child = spawn(process.execPath, [index], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 300 && !out.includes('PingOne Lab on'); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /mock sign-in is on/);
    const config = await (await fetch('http://127.0.0.1:5542/api/config')).json();
    assert.equal(config.mockSignin.allowed, true);
    const proxied = await (await fetch('http://127.0.0.1:5542/api/config', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).json();
    assert.deepEqual(proxied.mockSignin, { allowed: false });
  } finally { child.kill(); }
  // The wide-bind guard itself (not started here: it would listen beyond loopback).
  assert.match(mockSigninRefusalFor({ headers: {} }, { LAB_BIND: '0.0.0.0' }), /ALLOW_MOCK_SIGNIN/);
  assert.match(mockSigninRefusalFor({ headers: {} }, { ALLOW_MOCK_SIGNIN: '1', LAB_BIND: '0.0.0.0' }), /beyond loopback/);
});
