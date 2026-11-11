import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadCustomerConfig, publicConfig } from './customer.js';
import { renderStory, verticalList, StoryError } from './stories.js';
import { createSettings, REQUIRED, SettingsError } from './settings.js';
import { createOutbound } from './outbound.js';
import { createNetguard } from './netguard.js';
import { createMockP1, mockClientTable, USER as MOCK_USER } from './mockp1.js';
import { createP1, LabError } from './p1.js';
import { createPiFlow } from './piflow.js';
import { createCiba } from './ciba.js';
import { createExchange } from './exchange.js';
import { createGrants } from './grants.js';
import { cardList, discoveryCheck } from './cards.js';
import { createSessions, cookieName } from './session.js';
import { tokenView, traceContext } from './trace.js';
import { shelfInfo } from './shelfLink.js';

export const DEMO = { id: 'pingone-lab', name: 'PingOne Lab', version: '0.1.0' };
// Authorization-code cards on the pi.flow engine, and what each start sends.
const FLOW_CARDS = { pkce: {}, par: { par: true }, jar: { jar: true } };
const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
// The built UI loads only its own files: no third-party script, style, font or connection.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Every error is JSON with a fixed code; LabError adds a message written for the page and, when PingOne was
// already called, the redacted trace up to the failure. No stack, path or secret ever reaches the client.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof LabError) return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra?.trace ? { trace: err.extra.trace } : {}) });
  if (err instanceof SettingsError) return res.status(400).json({ error: 'invalid_setting', field: err.field, message: err.message });
  const status = Number(err?.status ?? err?.statusCode);
  if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
  if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
  console.error('[pingone-lab] unexpected error:', err?.name || 'Error'); // never the message: it could carry a value
  return res.status(500).json({ error: 'server_error' });
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((body) => {
  if (!res.headersSent) res.set('Cache-Control', 'no-store').json(body);
}).catch(next);

// Which Host headers and write Origins the lab answers. Loopback always; LAB_ALLOWED_HOSTS adds more names (comma
// separated host names that point at this Mac, such as a local domain). TLS (LAB_TLS_CERT and LAB_TLS_KEY) makes the origins https.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export function labAddresses({ port, env = process.env }) {
  const scheme = env.LAB_TLS_CERT && env.LAB_TLS_KEY ? 'https' : 'http';
  const extra = String(env.LAB_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of extra) if (!HOSTNAME.test(h)) throw Object.assign(new Error(`LAB_ALLOWED_HOSTS: not a host name: ${h}`), { field: 'env' });
  const names = ['127.0.0.1', 'localhost', '[::1]', ...extra];
  return {
    scheme,
    hosts: new Set(names.map((n) => `${n}:${port}`)),
    // Only these Hosts (the LAB_ALLOWED_HOSTS names, never loopback) may vouch for a lab-proxy's forwarded origin.
    proxyHosts: new Set(extra.map((n) => `${n}:${port}`)),
    origins: new Set(names.map((n) => `${scheme}://${n}:${port}`)),
  };
}

// Behind the family lab-proxy the browser's origin is the proxy's (https://local.ping-devops.com:8443) while Host is
// this lab's own LAB_ALLOWED_HOSTS name. X-Forwarded-Host/-Proto are believed only when Host is one of those names, so
// a request that did not come through the proxy (loopback Host, or any other Host) cannot use them.
export function isProxiedSameOrigin(headers, proxyHosts) {
  const origin = headers.origin;
  const xfh = String(headers['x-forwarded-host'] || '').trim().toLowerCase();
  const xfp = String(headers['x-forwarded-proto'] || '').trim().toLowerCase();
  return proxyHosts.has(String(headers.host || '').toLowerCase()) && xfh !== '' && (xfp === 'https' || xfp === 'http')
    && origin === `${xfp}://${xfh}`;
}

const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'via'];
// Why mock sign-in is refused for this request, or null when it is allowed.
// LAB_IN_CONTAINER=1 only counts when the process really is in a container: /.dockerenv, or a container runtime in
// the cgroup of process 1. Setting the variable on a bare Mac does not widen the bind's trust.
export function insideContainer(readFile = fs.readFileSync, exists = fs.existsSync) {
  if (exists('/.dockerenv')) return true;
  try { return /docker|containerd|kubepods|libpod/.test(String(readFile('/proc/1/cgroup', 'utf8'))); } catch { return false; }
}

// The family launcher (the lab-proxy in AI-DEMO-Standalone, shared/lab-proxy) is the one proxy mock sign-in is allowed
// through (owner decision, 2026-11-09). Deliberately a constant, not a setting: any other proxy is still refused.
export const LAUNCHER_ORIGIN = 'https://local.ping-devops.com:8443';
const LAUNCHER_FORWARDED_HOST = 'local.ping-devops.com:8443';

// True only for a request the launcher forwarded: Host is one of this lab's LAB_ALLOWED_HOSTS names (never loopback),
// X-Forwarded-Proto is https and X-Forwarded-Host is the launcher's. A write must carry the launcher's Origin; a GET
// may carry none (a same-origin browser GET sends none), and if it carries one it must be the launcher's.
export function isLauncherRequest(req, proxyHosts) {
  const h = req.headers;
  if (!proxyHosts.has(String(h.host || '').toLowerCase())) return false;
  if (String(h['x-forwarded-proto'] || '').trim().toLowerCase() !== 'https') return false;
  if (String(h['x-forwarded-host'] || '').trim().toLowerCase() !== LAUNCHER_FORWARDED_HOST) return false;
  const read = req.method === 'GET' || req.method === 'HEAD';
  if (h.origin === undefined) return read;
  return h.origin === LAUNCHER_ORIGIN && isProxiedSameOrigin(h, proxyHosts);
}

export function mockSigninRefusalFor(req, env, inContainer = insideContainer, proxyHosts = new Set()) {
  if (env.ALLOW_MOCK_SIGNIN !== '1') return 'Mock sign-in is off: start the lab with ALLOW_MOCK_SIGNIN=1 to sign in to the mock PingOne.';
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined) && !isLauncherRequest(req, proxyHosts)) return 'Mock sign-in is refused behind a proxy.';
  if (env.LAB_BIND === '0.0.0.0' && !(env.LAB_IN_CONTAINER === '1' && inContainer())) return 'Mock sign-in is refused when the lab listens beyond loopback.';
  return null;
}

// Host-run default (index.js, plain `npm start`): a lab on loopback with no PingOne environment configured runs mock,
// so mock sign-in is on unless the person chose (ALLOW_MOCK_SIGNIN set, even to 0). Anything wider than loopback, or a
// configured tenant, keeps it off; a proxy (other than the family launcher) is still refused per request by mockSigninRefusalFor.
export function hostRunMockSignin({ env, bind, tenantConfigured }) {
  return !env.ALLOW_MOCK_SIGNIN && bind === '127.0.0.1' && !tenantConfigured;
}

export function createApp({ port, fetchImpl = globalThis.fetch, settingsFile, sharedFile, now = Date.now, webDist = DEFAULT_WEB_DIST, customerFile, env = process.env } = {}) {
  // customer.config.json (or CUSTOMER_CONFIG): branding and vocabulary, validated once at start.
  const customer = loadCustomerConfig({ file: customerFile, env });
  const settings = createSettings({ file: settingsFile, ...(sharedFile !== undefined ? { sharedFile } : {}), port });
  const isMock = () => settings.mode() === 'mock';
  // Rule 19: Real is available only when the live configuration is complete (every required setting for every card).
  const liveConfigured = () => Object.keys(REQUIRED).every((card) => (REQUIRED[card] || []).every(([s, f]) => Boolean(settings.liveValue(s, f))));
  const mockSigninRefusal = (req) => mockSigninRefusalFor(req, env, insideContainer, addresses.proxyHosts);
  // Mock mode: the in-process mock PingOne answers every call (no call log, bounded state); the real fetch sits
  // behind the netguard, which refuses anything while the lab is in mock mode.
  const mock = createMockP1({ track: false, clients: mockClientTable() });
  const netguard = createNetguard({ fetchImpl, isMock });
  const outbound = createOutbound({ getAuthBase: () => settings.authBase(), fetchImpl: netguard.guarded, mockFetch: mock.fetchImpl, isMock });
  const p1 = createP1({ outbound, settings, now });
  const piflow = createPiFlow({ p1, settings, now });
  const ciba = createCiba({ p1, settings, now });
  const exchange = createExchange({ p1, settings });
  const grants = createGrants({ p1, settings, now });

  const addresses = labAddresses({ port, env });
  const sessions = createSessions({ now, secure: addresses.scheme === 'https' });

  const app = express();
  // index.js logs these at startup; the Settings page shows them (via /api/config).
  app.locals.customerWarnings = customer.warnings;
  app.locals.tenantConfigured = Boolean(settings.liveValue('p1', 'environmentId'));
  app.disable('x-powered-by');
  // Everything this request builds for the page (trace steps, token views) knows whether the lab is in mock mode.
  app.use((req, res, next) => traceContext.run({ mock: isMock() }, next));
  app.use((req, res, next) => {
    res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP });
    next();
  });
  const allowedHosts = addresses.hosts;
  const allowedOrigins = addresses.origins;

  app.use((req, res, next) => {
    if (!allowedHosts.has(req.headers.host ?? '')) return res.status(403).json({ error: 'host_not_allowed' });
    return next();
  });

  // GET only, no detail (demo-health/1). Behind the Host check, so DNS rebinding cannot read it.
  app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      schema: 'demo-health/1',
      at: new Date(now()).toISOString(),
      state: settings.ready('signin') ? 'ready' : 'needs-setup',
      runtime: isMock() ? 'offline' : 'live',
      demo: DEMO,
    });
  });

  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (origin && !allowedOrigins.has(origin) && !isProxiedSameOrigin(req.headers, addresses.proxyHosts)) return res.status(403).json({ error: 'cross_origin_write_refused' });
    if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'cross_origin_write_refused' });
    // A cross-site form cannot send application/json without a preflight, so every write must be JSON.
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'json_required' });
    return next();
  });
  app.use(express.json({ limit: '16kb' }));

  app.use(sessions.middleware);

  // Settings: secrets are write-only (the view says set: true/false).
  app.get('/api/settings', wrap(() => settings.publicView()));
  app.put('/api/settings', wrap((req) => {
    const view = settings.update(req.body);
    p1.clearCache();
    return view;
  }));

  app.get('/api/cards', wrap(() => ({ cards: cardList(settings, p1.cached()) })));

  // What the page needs to draw itself: branding, vocabulary, and which PingOne it talks to (for the banner).
  app.get('/api/config', wrap((req) => ({
    customer: publicConfig(customer, settings.mode()),
    version: DEMO.version,
    issuer: settings.issuer() || null,
    mode: settings.mode(),
    source: settings.mode() === 'mock' ? 'mock' : 'real',
    realAvailable: liveConfigured(),
    realReason: liveConfigured() ? null : 'Real (live) is not available: the live settings are incomplete. Set the PingOne environment id and every client id and secret on the Settings page.',
    workspace: req.session.workspace,
    // In mock mode the sign-in dialog shows the mock's demo user (it exists nowhere else) when mock sign-in is allowed.
    mockSignin: isMock() ? (mockSigninRefusal(req) ? { allowed: false } : { allowed: true, username: MOCK_USER.username, password: MOCK_USER.password }) : null,
  })));
  // Rule 19: what the Mock/Real toggle needs. Real (live) is available only when the live configuration is
  // complete (environment id and every required client setting); otherwise the toggle disables Real with what is missing.
  app.get('/api/info', wrap(() => {
    const liveReady = liveConfigured();
    return {
      source: settings.mode() === 'mock' ? 'mock' : 'real',
      realAvailable: liveReady,
      realReason: liveReady ? null : 'Real (live) needs the live settings to be complete: set the PingOne environment id and every client id and secret on the Settings page.',
      mode: settings.mode(),
      issuer: settings.issuer() || null,
    };
  }));
  // Mock or live, for the whole lab. A same-origin JSON write like every other.
  app.put('/api/mode', wrap((req) => {
    const requested = req.body?.mode;
    if (requested !== 'mock' && requested !== 'real') throw new LabError('bad_mode', 'mode must be exactly "mock" or "real"', 400);
    if (requested === 'real' && !liveConfigured()) {
      throw new LabError('real_not_available', 'Real (live) is not available: the live settings are incomplete. Set the PingOne environment id and every client id and secret on the Settings page.', 409);
    }
    const mode = settings.setMode(requested === 'real' ? 'live' : 'mock');
    p1.clearCache();
    return { mode, source: requested, issuer: settings.issuer() || null };
  }));
  app.get('/api/stories', wrap(() => ({ verticals: verticalList(), default: customer.config.vertical })));
  app.get('/api/stories/:vertical', wrap((req) => {
    try { return renderStory(req.params.vertical, customer.config); } catch (error) {
      if (error instanceof StoryError && error.message === 'unknown vertical') throw new LabError('unknown_vertical', 'Unknown vertical', 404);
      throw error;
    }
  }));
  // A POST (same-origin, JSON) because it calls PingOne: a cross-site GET must never cause an outbound call.
  app.post('/api/p1/discovery', wrap(() => discoveryCheck(p1)));

  // Sign-in: pi.flow only. Tokens stay in the session; /api/me shows them masked, with claims.
  // Signed in only with a verified identity; the session id is rotated so a planted id cannot ride the sign-in.
  // Rule 11: signing in to the mock needs ALLOW_MOCK_SIGNIN=1, and is refused behind a proxy (except the family
  // launcher, isLauncherRequest) or on a non-loopback bind. Docker binds 0.0.0.0 inside the container (LAB_IN_CONTAINER=1) while compose publishes 127.0.0.1 only.
  const mockGuard = (req) => {
    if (!isMock()) return;
    const why = mockSigninRefusal(req);
    if (why) throw new LabError('mock_signin_refused', why, 403);
  };
  const signedIn = (req, res, result) => {
    if (result.outcome === 'accepted' && result.identity?.subject) {
      req.session.user = { ...result.identity, signedInAt: new Date(now()).toISOString() };
      sessions.rotate(req.session, res);
    }
    return result;
  };
  app.post('/api/signin/start', wrap(async (req, res) => mockGuard(req) || signedIn(req, res, await piflow.start(req.session, 'signin', { loginHint: req.body?.loginHint }))));
  app.post('/api/signin/credentials', wrap(async (req, res) => mockGuard(req) || signedIn(req, res, await piflow.submitCredentials(req.session, 'signin', req.body || {}))));
  app.post('/api/signout', wrap((req, res) => {
    sessions.destroy(req.session);
    res.append('Set-Cookie', `${cookieName(req.session.workspace)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { signedIn: false };
  }));
  app.get('/api/me', wrap((req) => {
    const tokens = req.session.tokens.signin;
    return req.session.user
      ? { signedIn: true, user: req.session.user, accessToken: tokenView(tokens?.accessToken), idToken: tokenView(tokens?.idToken), tokenType: tokens?.tokenType || null }
      : { signedIn: false };
  }));


  app.post('/api/cards/client-credentials/token', wrap((req) => grants.clientCredentials(req.session)));
  app.post('/api/cards/lifecycle/refresh', wrap((req) => grants.refresh(req.session)));
  app.post('/api/cards/lifecycle/introspect', wrap((req) => grants.introspect(req.session)));
  app.post('/api/cards/lifecycle/revoke', wrap((req) => grants.revoke(req.session)));
  app.post('/api/cards/lifecycle/refresh-revoked', wrap((req) => grants.refresh(req.session, { afterRevoke: true })));
  app.post('/api/cards/userinfo/read', wrap((req) => grants.userinfo(req.session)));
  app.post('/api/cards/device/start', wrap((req) => grants.deviceStart(req.session)));
  app.post('/api/cards/device/poll', wrap((req) => grants.devicePoll(req.session)));

  app.post('/api/cards/ciba/start', wrap((req) => ciba.start(req.session, req.body || {})));
  app.post('/api/cards/ciba/poll', wrap((req) => ciba.poll(req.session)));

  app.post('/api/cards/token-exchange/run', wrap((req) => exchange.run(req.session)));

  // Authorization-code cards on the pi.flow engine (registered after the named cards above, so they never shadow them).
  const flowCard = (card) => {
    if (!Object.hasOwn(FLOW_CARDS, card)) throw new LabError('unknown_card', 'Unknown card', 404);
    return FLOW_CARDS[card];
  };
  app.post('/api/cards/:card/start', wrap(async (req) => {
    const opts = flowCard(req.params.card);
    mockGuard(req);
    return piflow.start(req.session, req.params.card, { ...opts, loginHint: (req.body || {}).loginHint });
  }));
  app.post('/api/cards/:card/credentials', wrap((req) => {
    flowCard(req.params.card);
    mockGuard(req);
    return piflow.submitCredentials(req.session, req.params.card, req.body || {});
  }));
  app.get('/api/cards/:card/result', wrap((req) => {
    const card = req.params.card;
    if (!Object.hasOwn(FLOW_CARDS, card) && card !== 'signin') throw new LabError('unknown_card', 'Unknown card', 404);
    return req.session.results[card] || { card, state: req.session.runs[card] ? 'running' : 'none' };
  }));

  // Reset clears the card runs, results and tokens of every session in the caller's workspace, and no other
  // workspace's; the sign-ins and the settings stay.
  app.post('/api/reset', wrap((req) => {
    const kept = sessions.reset(req.session);
    const cleared = sessions.resetWorkspace(req.session.workspace);
    return { ok: true, workspace: req.session.workspace, sessions: cleared, ...kept };
  }));

  // The header "Shelf" button. Always mounted (not only when a web build exists), and before the web fallback.
  app.get('/api/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo()); }); // the header "Shelf" button
  // The built web UI, when it exists. Registered last so it never shadows an API route.
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: 'index.html' }));
    app.get(/^\/(?!api(\/|$)).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
}
