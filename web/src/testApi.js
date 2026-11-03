import { vi } from 'vitest';

// A stand-in for the lab server in web tests: routes "METHOD /path" to a body (or a function of the request body).
// It records every call so tests can assert exactly what the page sent.
export function mockServer(routes) {
  const calls = [];
  const impl = vi.fn(async (path, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    // A function returns { status?, body }. A static value is the body, unless it is { status: <number>, body }.
    const reply = typeof route === 'function' ? route(body, calls)
      : (typeof route.status === 'number' && 'body' in route ? route : { body: route });
    const { status = 200, body: out } = reply;
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', impl);
  return { calls, impl };
}

export const ISSUER = 'https://auth.pingone.example/env-1/as';
export const CARDS = [
  { id: 'signin', title: 'Sign in (pi.flow)', kind: 'flow', ready: true, missing: [], advertised: true },
  { id: 'pkce', title: 'PKCE', kind: 'flow', ready: true, missing: [], advertised: true },
  { id: 'par', title: 'PAR', kind: 'flow', ready: true, missing: [], advertised: true },
  { id: 'jar', title: 'Signed request object (JAR)', kind: 'flow', ready: true, missing: [], advertised: null },
  { id: 'clientCredentials', title: 'Client credentials', kind: 'flow', ready: true, missing: [], advertised: true },
  { id: 'lifecycle', title: 'Token lifecycle: refresh, introspect, revoke', kind: 'flow', ready: true, missing: [], advertised: true },
  { id: 'userinfo', title: 'Userinfo', kind: 'flow', ready: true, missing: [], advertised: true },
  { id: 'device', title: 'Device authorization (RFC 8628)', kind: 'flow', ready: true, missing: [], advertised: false },
  { id: 'ciba', title: 'CIBA (start and poll)', kind: 'flow', ready: false, missing: ['ciba.clientId', 'ciba.clientSecret'], advertised: true },
  { id: 'tokenExchange', title: 'Token exchange (RFC 8693)', kind: 'flow', ready: true, missing: [], advertised: true },
  { id: 'playground', title: 'PingOne Protocol Playground', kind: 'playground', ready: true, missing: [] },
  { id: 'discovery', title: 'PingOne discovery check', kind: 'check', ready: true, missing: [] },
];

export const BASE_ROUTES = (issuer = ISSUER) => ({
  'GET /api/config': { customer: { name: 'PingOne Lab', tagline: 'Live', accent: '#b3122d', accentDark: '#ff6b7f', vocabulary: {}, warnings: [] }, issuer, mode: 'live', source: 'real', realAvailable: true, realReason: null },
  'GET /api/cards': { cards: CARDS },
  'GET /api/me': { signedIn: false },
  'GET /api/info': { source: 'real', realAvailable: true, realReason: null, mode: 'live', issuer },
  'GET /api/stories': { verticals: [{ id: 'banking', label: 'Banking' }, { id: 'retail', label: 'Retail' }], default: 'banking' },
  'GET /api/stories/banking': { vertical: 'banking', intro: ['Harbor Mutual intro.'], cards: { device: 'Dana links the TV app.' } },
  'GET /api/stories/retail': { vertical: 'retail', intro: ['Copperline intro.'], cards: { device: 'Alex signs in at the screen.' } },
});

// One trace step as the server records it.
export const hop = (id, title, method, url, status, body = {}) => ({ id, title, request: { method, url, headers: { traceparent: '00-a-b-01' } }, response: { status, body } });
