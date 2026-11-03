import { call } from './api.js';

// Every flow the lab runs, as data: its steps in order and the lab endpoint each step calls. The card run views and
// the Protocol Playground both run flows from here, so the two never drift apart.
// A step with `credentials: true` only runs when the step before it stopped waiting for a username or password.
// A step with `poll` repeats while PingOne says the request is still pending.
// The start step sends the typed user as login_hint.
const codeFlow = (card, startLabel) => ({
  steps: [
    { id: 'start', label: startLabel, path: card === 'signin' ? '/api/signin/start' : `/api/cards/${card}/start`, body: (o) => ({ loginHint: o.loginHint || undefined }) },
    { id: 'credentials', label: 'Post the username and password (usernamePassword.check)', path: card === 'signin' ? '/api/signin/credentials' : `/api/cards/${card}/credentials`, credentials: true },
  ],
});

export const FLOWS = {
  signin: { title: 'Sign in (pi.flow)', ...codeFlow('signin', 'Open a pi.flow sign-in') },
  pkce: { title: 'PKCE', ...codeFlow('pkce', 'Open a pi.flow with an S256 code challenge') },
  par: { title: 'PAR', ...codeFlow('par', 'Push the request (PAR) and open the flow') },
  jar: { title: 'Signed request object (JAR)', ...codeFlow('jar', 'Sign the request object (HS256) and open the flow') },
  clientCredentials: { title: 'Client credentials', steps: [{ id: 'token', label: 'Ask for a token as the application itself', path: '/api/cards/client-credentials/token' }] },
  lifecycle: {
    title: 'Token lifecycle',
    steps: [
      { id: 'refresh', label: 'Refresh: trade the refresh token for new tokens', path: '/api/cards/lifecycle/refresh' },
      { id: 'introspect', label: 'Introspect the access token', path: '/api/cards/lifecycle/introspect' },
      { id: 'revoke', label: 'Revoke the refresh token', path: '/api/cards/lifecycle/revoke' },
      { id: 'refresh-revoked', label: 'Try the revoked refresh token (PingOne must refuse)', path: '/api/cards/lifecycle/refresh-revoked' },
    ],
  },
  userinfo: { title: 'Userinfo', steps: [{ id: 'read', label: 'Read the user\'s claims with the access token', path: '/api/cards/userinfo/read' }] },
  device: {
    title: 'Device authorization',
    steps: [
      { id: 'start', label: 'Ask PingOne for a user code', path: '/api/cards/device/start' },
      { id: 'poll', label: 'Poll while the person signs in on another device', path: '/api/cards/device/poll', poll: true },
    ],
  },
  ciba: {
    title: 'CIBA',
    steps: [
      { id: 'start', label: 'Ask PingOne to get the user\'s approval (backchannel)', path: '/api/cards/ciba/start', body: (o) => ({ loginHint: o.loginHint || undefined, bindingMessage: o.bindingMessage || undefined }) },
      { id: 'poll', label: 'Poll until approved, denied or expired', path: '/api/cards/ciba/poll', poll: true },
    ],
  },
  tokenExchange: { title: 'Token exchange', steps: [{ id: 'run', label: 'Exchange the user\'s token (with the actor\'s, when set)', path: '/api/cards/token-exchange/run' }] },
  discovery: { title: 'Discovery check', steps: [{ id: 'check', label: 'Read PingOne discovery', path: '/api/p1/discovery' }] },
};
export const FLOW_IDS = Object.keys(FLOWS);

export const MAX_POLLS = 60;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Should this step run, given what the previous step answered?
export function needsStep(step, previous) {
  if (!step.credentials) return true;
  return previous?.data?.state === 'credentials_required';
}

// Runs one step. Credential steps send the typed username and password (to the lab server only).
export async function runStep(step, { options = {}, credentials, onPoll, sleep = wait } = {}) {
  const body = step.credentials ? credentials : (step.body ? step.body(options) : {});
  let result = await call('POST', step.path, body);
  if (step.poll) {
    for (let i = 0; result.ok && result.data?.state === 'pending' && i < MAX_POLLS; i += 1) {
      onPoll?.(result);
      await sleep(Math.max(1, Number(result.data.interval) || 2) * 1000);
      result = await call('POST', step.path, {});
    }
  }
  return result;
}

// The trace to show: the newest one any step returned (the server sends the run's whole trace so far).
export function latestTrace(results) {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const trace = results[i]?.data?.trace;
    if (Array.isArray(trace) && trace.length) return trace;
  }
  return [];
}

// Plain names for what a trace step asked PingOne for.
const PHRASES = {
  discovery: 'the discovery request',
  authorize: 'the pi.flow authorization request',
  read: 'the read-back of the flow',
  lookup: 'the username (user.lookup)',
  credentials: 'the username and password',
  resume: 'the request for the authorization code (resume)',
  token: 'the token request',
  par: 'the pushed authorization request',
  refresh: 'the refresh',
  'refresh-revoked': 'the revoked refresh token',
  introspect: 'the introspection',
  revoke: 'the revocation',
  userinfo: 'the userinfo request',
  start: 'the start request',
  poll: 'the poll',
  'actor-token': 'the actor\'s own token',
  exchange: 'the token exchange',
};
export const phraseFor = (traceStep) => PHRASES[traceStep?.id] || `"${String(traceStep?.title || 'the request').toLowerCase()}"`;

// Calls a run makes on purpose to show PingOne saying no. A refusal here is the correct answer (a pass); an
// acceptance means PingOne is set up wrong.
export const EXPECTED_REFUSALS = new Set(['refresh-revoked']);
// CIBA and device polls answer these while the person has not approved yet: waiting, not refused.
const STILL_WAITING = new Set(['authorization_pending', 'slow_down']);

// One plain sentence per PingOne answer: what it accepted and what it refused, with the status.
export function stepSentence(traceStep) {
  const status = traceStep?.response?.status;
  if (!Number.isInteger(status)) return null;
  const body = traceStep.response.body;
  const why = body && typeof body === 'object' ? (body.error || body.code || '') : '';
  // PingOne's own words for the refusal, when it sends them.
  const words = body && typeof body === 'object' ? (body.error_description || body.message) : null;
  const said = typeof words === 'string' ? ` (${words.slice(0, 200)})` : '';
  if (EXPECTED_REFUSALS.has(traceStep.id)) {
    return status >= 400
      ? { tone: 'expected', tag: 'refused as expected', text: `PingOne refused ${phraseFor(traceStep)}, as it should: ${status}${why ? ` ${why}` : ''}` }
      : { tone: 'error', text: `PingOne accepted ${phraseFor(traceStep)} (${status}), but it should have refused it. Check its settings.` };
  }
  if (traceStep.id === 'poll' && status >= 400 && STILL_WAITING.has(why)) return { tone: 'info', tag: 'waiting', text: `PingOne says the approval is still pending: ${status} ${why}` };
  if (status >= 400) return { tone: 'refused', text: `PingOne refused ${phraseFor(traceStep)}: ${status}${why ? ` ${why}` : ''}${said}` };
  if (status >= 300) return { tone: 'info', text: `PingOne answered ${phraseFor(traceStep)} with a redirect: ${status} (not followed)` };
  return { tone: 'accepted', text: `PingOne accepted ${phraseFor(traceStep)}: ${status}` };
}

const yesNo = (ok, yes, no) => ({ tone: ok ? 'accepted' : 'refused', text: ok ? yes : no });

// What the run proves, in plain language: one line per PingOne answer, then the card's own conclusions.
export function proofPoints(flowId, results) {
  const points = [];
  for (const s of latestTrace(results)) { const line = stepSentence(s); if (line) points.push(line); }
  const last = results.at(-1);
  if (!last) return points;
  const d = last.data || {};
  if (!last.ok) {
    points.push({ tone: 'error', text: `The lab stopped: ${d.error || `HTTP ${last.status}`}${d.message ? `: ${d.message}` : ''}` });
    return points;
  }
  if (d.state === 'credentials_required') points.push({ tone: 'info', text: d.refused ? 'PingOne refused the username or password; the flow still waits for them.' : `PingOne is waiting for a username and password (${d.status}).` });
  if (d.state === 'stopped') points.push({ tone: 'info', text: `PingOne's sign-on policy asks for ${d.status}, which this lab does not drive (it signs in with a password only). Use a policy with username and password.` });
  if (d.outcome === 'accepted') {
    if (flowId === 'lifecycle') {
      if (d.active !== undefined) points.push(yesNo(d.active, 'The access token is active.', 'PingOne says the access token is not active.'));
      else if (d.revoked) points.push({ tone: 'accepted', text: 'PingOne revoked the refresh token. The access token (a JWT) stays valid until it expires.' });
      else points.push({ tone: 'accepted', text: `New tokens issued${d.rotated ? '; PingOne rotated the refresh token' : ''}.` });
    } else if (flowId === 'userinfo') {
      points.push(yesNo(d.subMatches, `Userinfo answered for the signed-in user (${(d.claims || []).join(', ')}).`, 'Userinfo answered for a different subject than the ID token.'));
    } else if (flowId === 'clientCredentials') {
      points.push({ tone: 'accepted', text: `Done: PingOne issued a token to the application${d.scope ? ` with scope ${d.scope}` : ''}. No user is involved.` });
    } else if (flowId !== 'tokenExchange') {
      points.push({ tone: 'accepted', text: d.identity?.subject ? `Done: PingOne issued tokens; the verified ID token names ${d.identity.username || d.identity.subject}.` : 'Done: PingOne issued the tokens.' });
    }
  }
  if (d.outcome === 'refused') {
    const expected = flowId === 'lifecycle' && (d.trace || []).at(-1)?.id === 'refresh-revoked';
    points.push(expected
      ? { tone: 'expected', tag: 'refused as expected', text: `PingOne refused the revoked refresh token: ${d.reason}. Revocation works.` }
      : { tone: 'refused', text: `PingOne refused the request: ${d.reason}${d.description ? ` (${d.description})` : ''}` });
  }
  if (d.outcome === 'failed' && d.reason === 'flow_gone') points.push({ tone: 'error', text: 'PingOne no longer knows this sign-in (404): it expired while it waited. Press Run to start again.' });
  else if (d.outcome === 'failed' && flowId !== 'tokenExchange') points.push({ tone: 'error', text: `The run failed a check: ${d.reason}` });
  if (flowId === 'device' && d.state === 'pending' && d.userCode) points.push({ tone: 'info', tag: 'waiting', text: `Waiting for someone to enter ${d.userCode} at PingOne${d.verificationUri ? ` (${d.verificationUri})` : ''}.` });
  if ((flowId === 'ciba' || flowId === 'device') && d.state && d.state !== 'pending') {
    points.push({ tone: d.state === 'approved' ? 'accepted' : 'refused', text: `The request ended: ${d.state}${d.identity?.subject ? ` (ID token for ${d.identity.subject})` : ''}.` });
  }
  if (flowId === 'tokenExchange' && Array.isArray(d.checks)) {
    for (const c of d.checks) points.push(yesNo(c.ok, `Check passed: ${c.name}.`, `Check FAILED: ${c.name}.`));
    if (d.actChain?.length) points.push({ tone: 'info', text: `act chain, outermost first: ${d.actChain.join(' -> ')}` });
  }
  if (flowId === 'discovery' && Array.isArray(d.features)) {
    for (const f of d.features) points.push({ tone: f.supported ? 'accepted' : 'info', text: `${f.label}: ${f.supported ? 'advertised' : 'not advertised'}` });
  }
  return points;
}

// Friendly name of the PingOne endpoint a URL points at.
export function endpointName(url) {
  const p = (() => { try { return new URL(url).pathname; } catch { return String(url || ''); } })();
  const last = p.split('/').filter(Boolean).pop() || '';
  if (p.includes('openid-configuration')) return 'Discovery';
  if (p.includes('/flows/')) return 'Flows API';
  const names = { par: 'PAR endpoint', authorize: 'Authorization endpoint', resume: 'Resume endpoint', cibaAuthorization: 'Backchannel endpoint',
    device_authorization: 'Device authorization endpoint', jwks: 'JWKS', token: 'Token endpoint', introspect: 'Introspection endpoint', revoke: 'Revocation endpoint', userinfo: 'Userinfo endpoint' };
  return names[last] || 'PingOne';
}

const PER_ROW = 3;

// The live sequence of a run, as diagram-studio/1 data built from the captured trace: one box per PingOne
// call (green accepted, blue refused as expected, amber refused), in order, so the shared DiagramView can walk it with Simulate.
export function traceToDiagram(trace, title = 'This run, call by call') {
  const calls = (trace || []).filter((s) => s?.request && Number.isInteger(s?.response?.status));
  if (!calls.length) return null;
  // A trace step answered by the in-process mock says so (s.mock): the first box then names the mock, not a real PingOne.
  const mock = calls.some((s) => s.mock);
  const nodes = [{ id: 'lab', group: 'lab', label: 'This lab (server)', sub: [mock ? 'Calls the in-lab mock PingOne' : 'Every call below is real'], x: 0, y: 0 }];
  const edges = [];
  const steps = [];
  calls.forEach((s, i) => {
    const status = s.response.status;
    const slot = i + 1;
    const row = Math.floor(slot / PER_ROW);
    const col = row % 2 === 0 ? slot % PER_ROW : PER_ROW - 1 - (slot % PER_ROW);
    const id = `c${i + 1}`;
    const sentence = stepSentence(s);
    nodes.push({
      id,
      group: status < 400 ? 'accepted' : sentence?.tone === 'expected' ? 'expected' : 'refused',
      label: `${i + 1}. ${String(s.title || s.id).slice(0, 70)}`,
      sub: [`${s.request.method} ${endpointName(s.request.url)}`, `${status}${s.response.body?.error ? ` ${String(s.response.body.error).slice(0, 60)}` : ''}`],
      x: col * 300,
      y: row * 170,
    });
    edges.push({ source: i === 0 ? 'lab' : `c${i}`, target: id, label: s.request.method, dashed: status >= 400 });
    steps.push({ title: `${i + 1}. ${String(s.title || s.id).slice(0, 110)}`, what: (sentence?.text || '').slice(0, 600), hop: String(s.id || 'hop').replace(/[^A-Za-z0-9._:/-]/g, '-').slice(0, 64), edges: [i] });
  });
  return {
    schema: 'diagram-studio/1',
    id: 'live-run',
    title,
    lede: 'Built from the trace this run captured. Green: PingOne accepted. Blue, dashed: PingOne refused, as it should (the run tests that on purpose). Amber, dashed: PingOne refused.',
    groups: { lab: { label: 'This lab', color: 'dark' }, accepted: { label: 'Accepted', color: 'green' }, expected: { label: 'Refused as expected', color: 'blue' }, refused: { label: 'Refused', color: 'amber' } },
    nodes: nodes.slice(0, 60),
    edges: edges.slice(0, 59),
    steps: steps.slice(0, 59),
  };
}
