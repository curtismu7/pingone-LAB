#!/usr/bin/env node
// doctor: one line per check, exit 1 when any check fails. Read-only: it changes no setting, calls no PingOne, and
// runs the lab's mock mode in-process against a throwaway settings file, and never reads your real settings file.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/src/app.js';
import { createSettings, DEFAULT_PORT } from '../server/src/settings.js';
import { createMockP1, ENV_ID, MOCK_ORIGIN } from '../server/src/mockp1.js';
import { selfTest } from '../server/src/netguard.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || DEFAULT_PORT);
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`ok    ${name}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}: ${error.message}`);
  }
};

// GET /api/health on the loopback address over http, then https (the container serves https with its own certificate).
function health(p) {
  const attempt = (lib, scheme) => new Promise((resolve, reject) => {
    const req = lib.get({ host: '127.0.0.1', port: p, path: '/api/health', rejectUnauthorized: false, timeout: 2000 }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(new Error(`${scheme} answer is not JSON`)); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
  return attempt(http, 'http').catch(() => attempt(https, 'https'));
}

const canBind = (p) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(p, '127.0.0.1', () => server.close(() => resolve(true)));
});

await check('Node 26 or newer', () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 26) throw new Error(`Node ${process.versions.node}; the lab needs 26 or newer`);
  return `Node ${process.versions.node}`;
});

// The doctor never reads the owner's real settings. It checks a settings file only when you name one with
// P1LAB_SETTINGS_FILE; otherwise it reads a path that does not exist, which is the state of a fresh clone.
await check('settings file readable', () => {
  const named = process.env.P1LAB_SETTINGS_FILE;
  const file = named || path.join(os.tmpdir(), 'p1lab-doctor-no-settings', 'pingone-lab.json');
  const settings = createSettings({ file, sharedFile: '' });
  const found = fs.existsSync(settings.file);
  return `${found ? 'found' : (named ? 'not found at the path you named' : 'none read (name one with P1LAB_SETTINGS_FILE to check yours); mock mode works without one')}; mode ${settings.mode()}`;
});

await check('netguard self-test (mock mode never reaches the network)', async () => {
  const result = await selfTest();
  if (!result.ok) throw new Error('the guard let a real request through or refused the mock');
});

await check('mock PingOne answers discovery', async () => {
  const mock = createMockP1({ track: false });
  const res = await mock.fetchImpl(`${MOCK_ORIGIN}/${ENV_ID}/as/.well-known/openid-configuration`);
  const body = await res.json();
  if (!res.ok || !body.issuer) throw new Error('no discovery document');
  return 'issuer found';
});

await check('port 5500-5549 free, or already this lab', async () => {
  if (!Number.isInteger(port) || port < 5500 || port > 5549) throw new Error(`PORT ${port} is outside 5500-5549`);
  if (await canBind(port)) return `${port} is free`;
  const answer = await health(port).catch(() => null);
  if (answer?.demo?.id === 'pingone-lab') return `${port} is this lab, already running`;
  throw new Error(`${port} is taken by something else (see the README for what to do)`);
});

await check('health route answers demo-health/1 (mock mode, in-process)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1lab-doctor-'));
  const file = path.join(dir, 'pingone-lab.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, values: {}, mode: 'mock' }), { mode: 0o600 });
  const server = http.createServer();
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const p = server.address().port;
    server.on('request', createApp({ port: p, settingsFile: file, sharedFile: path.join(dir, 'none.env'), webDist: path.join(dir, 'none'), customerFile: path.join(dir, 'none.json'), env: {} }));
    const body = await (await fetch(`http://127.0.0.1:${p}/api/health`)).json();
    if (body.schema !== 'demo-health/1' || body.runtime !== 'offline') throw new Error('unexpected health answer');
    return `runtime ${body.runtime}`;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('diagrams load', () => {
  const dir = path.join(root, 'web/src/diagrams');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (!files.length) throw new Error('no diagram files');
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error(`${f} has no nodes and edges`);
  }
  return `${files.length} diagrams`;
});

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
