import { describe, it, expect, vi, afterEach } from 'vitest';
import { FLOWS, FLOW_IDS, needsStep, runStep, stepSentence, proofPoints, traceToDiagram, latestTrace, endpointName } from './flows.js';
import { validateDiagram } from './diagrams/validate.js';
import { mockServer, hop } from './testApi.js';
import { SPEC } from './content.js';

afterEach(() => vi.unstubAllGlobals());

const P1 = 'https://auth.pingone.example/env-1';

describe('flows', () => {
  it('covers every runnable card plus discovery, only what PingOne advertises, and only calls the lab\'s own /api', () => {
    expect(FLOW_IDS).toEqual(['signin', 'pkce', 'par', 'jar', 'clientCredentials', 'lifecycle', 'userinfo', 'device', 'ciba', 'tokenExchange', 'discovery']);
    for (const absent of ['dcr', 'rar', 'dpop']) expect(FLOW_IDS).not.toContain(absent);
    for (const id of FLOW_IDS) for (const s of FLOWS[id].steps) expect(s.path).toMatch(/^\/api\//);
  });

  it('runs a credentials step only when PingOne asked for a password', () => {
    const step = FLOWS.pkce.steps[1];
    expect(needsStep(step, { data: { state: 'credentials_required' } })).toBe(true);
    expect(needsStep(step, { data: { outcome: 'accepted' } })).toBe(false);
    expect(needsStep(FLOWS.pkce.steps[0], null)).toBe(true);
  });

  it('polls CIBA and device while pending, at the interval, and stops when they end', async () => {
    for (const flow of ['ciba', 'device']) {
      let n = 0;
      const server = mockServer({ [`POST /api/cards/${flow}/poll`]: () => ({ body: (n += 1) < 3 ? { state: 'pending', interval: 2 } : { state: 'approved' } }) });
      const sleep = vi.fn(async () => {});
      const result = await runStep(FLOWS[flow].steps[1], { sleep });
      expect(result.data.state).toBe('approved');
      expect(server.calls).toHaveLength(3);
      expect(sleep).toHaveBeenCalledWith(2000);
      vi.unstubAllGlobals();
    }
  });

  it('sends login_hint for a code flow and the typed credentials for a credentials step, nothing else', async () => {
    const server = mockServer({ 'POST /api/cards/jar/start': { state: 'done' }, 'POST /api/cards/jar/credentials': { state: 'done' } });
    await runStep(FLOWS.jar.steps[0], { options: { loginHint: 'alice', extra: 'x' } });
    await runStep(FLOWS.jar.steps[1], { credentials: { username: 'u', password: 'p' } });
    expect(server.calls[0].body).toEqual({ loginHint: 'alice' });
    expect(server.calls[1].body).toEqual({ username: 'u', password: 'p' });
  });
});

describe('proof', () => {
  it('names a refusal plainly, with the status, PingOne\'s error and its words', () => {
    expect(stepSentence(hop('par', 'Push', 'POST', `${P1}/as/par`, 400, { error: 'invalid_request' })))
      .toEqual({ tone: 'refused', text: 'PingOne refused the pushed authorization request: 400 invalid_request' });
    expect(stepSentence(hop('authorize', 'Open', 'GET', `${P1}/as/authorize`, 400, { error: 'invalid_request_object', error_description: 'bad signature' })).text)
      .toBe('PingOne refused the pi.flow authorization request: 400 invalid_request_object (bad signature)');
    expect(stepSentence(hop('token', 'Redeem', 'POST', `${P1}/as/token`, 200)).text).toBe('PingOne accepted the token request: 200');
    expect(stepSentence({ id: 'request-object', title: 'No call' })).toBeNull();
  });

  it('the revoked refresh token is a refusal the run asks for: a pass; accepting it is an error; pending polls are waiting', () => {
    expect(stepSentence(hop('refresh-revoked', 'Try again', 'POST', `${P1}/as/token`, 400, { error: 'invalid_grant' })))
      .toEqual({ tone: 'expected', tag: 'refused as expected', text: 'PingOne refused the revoked refresh token, as it should: 400 invalid_grant' });
    expect(stepSentence(hop('refresh-revoked', 'Try again', 'POST', `${P1}/as/token`, 200)))
      .toEqual({ tone: 'error', text: 'PingOne accepted the revoked refresh token (200), but it should have refused it. Check its settings.' });
    expect(stepSentence(hop('poll', 'Poll', 'POST', `${P1}/as/token`, 400, { error: 'authorization_pending' })))
      .toEqual({ tone: 'info', tag: 'waiting', text: 'PingOne says the approval is still pending: 400 authorization_pending' });
    expect(stepSentence(hop('poll', 'Poll', 'POST', `${P1}/as/token`, 400, { error: 'access_denied' })).tone).toBe('refused');
    const lifecycle = proofPoints('lifecycle', [{ ok: true, data: { outcome: 'refused', reason: 'invalid_grant', trace: [hop('refresh-revoked', 'x', 'POST', `${P1}/as/token`, 400, { error: 'invalid_grant' })] } }]);
    expect(lifecycle.map((p) => p.tone)).toEqual(['expected', 'expected']);
    expect(traceToDiagram(lifecycle.length ? [hop('refresh-revoked', 'x', 'POST', `${P1}/as/token`, 400)] : []).nodes.map((n) => n.group)).toEqual(['lab', 'expected']);
  });

  it('adds the card\'s own conclusions and the server error code and detail', () => {
    const failed = proofPoints('pkce', [{ ok: false, status: 409, data: { error: 'not_advertised', message: 'Your PingOne does not advertise this' } }]);
    expect(failed.at(-1)).toEqual({ tone: 'error', text: 'The lab stopped: not_advertised: Your PingOne does not advertise this' });
    const gone = proofPoints('signin', [{ ok: true, data: { outcome: 'failed', reason: 'flow_gone' } }]);
    expect(gone.at(-1).text).toMatch(/no longer knows this sign-in \(404\).*Press Run/);
    const stopped = proofPoints('signin', [{ ok: true, data: { state: 'stopped', status: 'MFA_REQUIRED' } }]);
    expect(stopped.at(-1).text).toMatch(/MFA_REQUIRED.*does not drive/);
    const ex = proofPoints('tokenExchange', [{ ok: true, data: { outcome: 'failed', checks: [{ name: 'act.sub names the actor', ok: false }], actChain: [] } }]);
    expect(ex.map((p) => p.text)).toEqual(['Check FAILED: act.sub names the actor.']);
    const cc = proofPoints('clientCredentials', [{ ok: true, data: { outcome: 'accepted', scope: 'orders:read' } }]);
    expect(cc.at(-1).text).toMatch(/to the application with scope orders:read\. No user/);
    const ui = proofPoints('userinfo', [{ ok: true, data: { outcome: 'accepted', subMatches: false, claims: ['sub'] } }]);
    expect(ui.at(-1).tone).toBe('refused');
    const device = proofPoints('device', [{ ok: true, data: { state: 'pending', userCode: 'WDJB-MJHT', verificationUri: `${P1}/device` } }]);
    expect(device.at(-1)).toMatchObject({ tone: 'info', tag: 'waiting' });
    expect(device.at(-1).text).toContain('WDJB-MJHT');
    const intro = proofPoints('lifecycle', [{ ok: true, data: { outcome: 'accepted', active: true } }]);
    expect(intro.at(-1).text).toBe('The access token is active.');
  });

  it('uses the newest trace any step returned', () => {
    expect(latestTrace([{ data: { trace: [1] } }, { data: {} }, { data: { trace: [1, 2] } }])).toEqual([1, 2]);
    expect(latestTrace([])).toEqual([]);
  });

  it('names PingOne endpoints from their URL', () => {
    expect(endpointName(`${P1}/as/par`)).toBe('PAR endpoint');
    expect(endpointName(`${P1}/flows/<flow id>`)).toBe('Flows API');
    expect(endpointName(`${P1}/as/token`)).toBe('Token endpoint');
    expect(endpointName(`${P1}/as/resume`)).toBe('Resume endpoint');
    expect(endpointName(`${P1}/as/device_authorization`)).toBe('Device authorization endpoint');
    expect(endpointName(`${P1}/as/.well-known/openid-configuration`)).toBe('Discovery');
  });
});

describe('live sequence diagram', () => {
  it('is valid diagram-studio/1 data built from the trace, one box per call in order', () => {
    const trace = [hop('a', 'First', 'GET', `${P1}/as/.well-known/openid-configuration`, 200), { id: 'request-object', title: 'no call' }, hop('b', 'Second', 'POST', `${P1}/as/token`, 401, { error: 'invalid_client' })];
    const d = traceToDiagram(trace);
    expect(validateDiagram(d)).toEqual([]);
    expect(d.nodes.map((n) => n.group)).toEqual(['lab', 'accepted', 'refused']);
    expect(d.edges[1]).toMatchObject({ source: 'c1', target: 'c2', dashed: true });
    expect(d.steps).toHaveLength(2);
    expect(traceToDiagram([])).toBeNull();
  });

  it('stays within the studio limits for a very long trace', () => {
    const trace = Array.from({ length: 200 }, (_, i) => hop(`h${i}`, `Call ${i}`, 'POST', `${P1}/as/token`, 200));
    expect(validateDiagram(traceToDiagram(trace))).toEqual([]);
  });
});

describe('spec notes', () => {
  it('every flow has one, with a link only to a public spec host', () => {
    expect(Object.keys(SPEC).sort()).toEqual([...FLOW_IDS].sort());
    for (const id of FLOW_IDS) {
      for (const field of ['solves', 'example', 'agents']) expect([id, field, SPEC[id][field].length > 20]).toEqual([id, field, true]);
      for (const ref of SPEC[id].refs) expect(ref.url).toMatch(/^https:\/\/(www\.rfc-editor\.org\/rfc\/rfc\d+|openid\.net\/specs\/)/);
    }
  });
});

describe('live diagram wording follows the mode', () => {
  const trace = (mock) => [{ ...hop('token', 'Token', 'POST', `${P1}/as/token`, 200), ...(mock ? { mock: true } : {}) }];
  it('names the mock when the calls were answered by it, and says every call is real otherwise', () => {
    expect(traceToDiagram(trace(true)).nodes[0].sub).toEqual(['Calls the in-lab mock PingOne']);
    expect(traceToDiagram(trace(false)).nodes[0].sub).toEqual(['Every call below is real']);
  });
});
