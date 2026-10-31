import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('npm run doctor: one line per check, every check passes, exit 0', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/doctor.mjs')], { env: { ...process.env, PORT: '5549', P1LAB_SETTINGS_FILE: path.join(root, 'no-such-dir', 'x.json') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.length >= 7, 'one line per check, plus the summary');
  assert.ok(lines.slice(0, -1).every((l) => /^(ok|FAIL) {2,4}\S/.test(l)));
  assert.ok(!r.stdout.includes('FAIL'));
});

test('npm run doctor never reads the owner\'s real settings file (the default path under HOME)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p1lab-home-'));
  const dir = path.join(home, '.config', 'demo-kit', 'pingone-lab');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pingone-lab.json'), JSON.stringify({ version: 1, mode: 'live', values: { p1: { environmentId: '11111111-1111-4111-8111-111111111111' } } }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, PORT: '5549' };
  delete env.P1LAB_SETTINGS_FILE;
  try {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts/doctor.mjs')], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /settings file readable: none read/);
    assert.match(r.stdout, /mode mock/, 'a live file under HOME was not used');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('npm run doctor exits 1 when a check fails (a port outside 5500-5549)', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/doctor.mjs')], { env: { ...process.env, PORT: '8080' }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL {2}port/);
});

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('npm run reset with no lab running says so and exits 0', async () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/reset.mjs')], { env: { ...process.env, PORT: String(await freePort()) }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to reset/);
});
