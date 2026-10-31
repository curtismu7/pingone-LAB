import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { createFakeP1, ENV_ID } from './fakep1.js';

export const tempSettingsFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p1lab-')), 'pingone-lab.json');

// Every client the fake knows, configured in the lab's settings the way an owner would.
export const CLIENTS = {
  'signin-client': { secret: 'signin-secret-value-1', scopes: [] },
  'pkce-client': { scopes: [] },
  'par-client': { secret: 'par-secret-value-1', scopes: [] },
  'jar-client': { secret: 'jar-secret-value-1', scopes: [] },
  'cc-client': { secret: 'cc-secret-value-1', scopes: ['orders:read'] },
  'device-client': { scopes: [] },
  'ciba-client': { secret: 'ciba-secret-value-1', scopes: [] },
  'exchange-client': { secret: 'exchange-secret-value-1', scopes: [] },
  'actor-client': { secret: 'actor-secret-value-1', scopes: ['agent:invoke'] },
};

export const FULL_SETTINGS = {
  p1: { environmentId: ENV_ID, region: 'com' },
  signin: { clientId: 'signin-client', clientSecret: 'signin-secret-value-1' },
  pkce: { clientId: 'pkce-client' },
  par: { clientId: 'par-client', clientSecret: 'par-secret-value-1' },
  jar: { clientId: 'jar-client', clientSecret: 'jar-secret-value-1' },
  clientCredentials: { clientId: 'cc-client', clientSecret: 'cc-secret-value-1', scope: 'orders:read' },
  device: { clientId: 'device-client' },
  ciba: { clientId: 'ciba-client', clientSecret: 'ciba-secret-value-1' },
  tokenExchange: {
    exchangeClientId: 'exchange-client', exchangeClientSecret: 'exchange-secret-value-1',
    actorClientId: 'actor-client', actorClientSecret: 'actor-secret-value-1', actorScope: 'agent:invoke',
  },
};

export async function startLab({ fake: fakeOptions = {}, settings = FULL_SETTINGS, mode, fetchImpl, now, env } = {}) {
  const fake = createFakeP1({ clients: structuredClone(CLIENTS), ...fakeOptions });
  const file = tempSettingsFile();
  // mode: 'mock' | 'live' stored in the file; unset means live when an environment is configured, else mock.
  if (settings || mode) fs.writeFileSync(file, JSON.stringify({ version: 1, values: settings || {}, ...(mode ? { mode } : {}) }), { mode: 0o600 });
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // No built UI and no customer.config by default, so tests never depend on a local build or file.
  server.on('request', createApp({ port, fetchImpl: fetchImpl || fake.fetchImpl, settingsFile: file, sharedFile: path.join(path.dirname(file), 'no-shared.json'), webDist: path.join(path.dirname(file), 'no-dist'), customerFile: path.join(path.dirname(file), 'no-customer.json'), ...(now ? { now } : {}), ...(env ? { env } : {}) }));
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const bodies = []; // every response text the "browser" saw, for leak checks

  async function call(method, route, body, headers = {}) {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json', Origin: base } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : (method !== 'GET' ? '{}' : undefined),
    });
    // The last Set-Cookie wins, as in a browser (a sign-in may create and then rotate the session in one reply).
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.at(-1).split(';')[0];
    const text = await res.text();
    bodies.push(text);
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return { status: res.status, data, text, headers: res.headers };
  }

  // Signs in through pi.flow with the fake's user.
  async function signIn(password = 'correct-horse-battery') {
    const started = await call('POST', '/api/signin/start');
    if (started.data?.state !== 'credentials_required') return started;
    return call('POST', '/api/signin/credentials', { username: 'alice', password });
  }

  // No secret the fake handed out (or saw) may appear in anything the page received.
  function leaks() {
    const all = bodies.join('\n');
    return [...fake.secrets].filter((s) => s && all.includes(s));
  }

  const close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return { base, port, call, signIn, leaks, close, fake, file, bodies, cookie: () => cookie, setCookie: (c) => { cookie = c; } };
}
