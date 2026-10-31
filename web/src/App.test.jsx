import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { bannerText, parseRoute } from './App.jsx';
import { mockServer, BASE_ROUTES, CARDS, ISSUER, hop } from './testApi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const go = (hash) => { window.location.hash = hash; };

beforeEach(() => { go('#/'); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('banner (rule 2)', () => {
  it('says live with the issuer, or not connected', () => {
    expect(bannerText(ISSUER)).toBe(`Live: every call goes to your PingOne environment at ${ISSUER}. Nothing here is simulated.`);
    expect(bannerText(null)).toBe('Live, not connected: set your PingOne environment in Settings, or switch to Mock.');
    expect(bannerText('https://auth.pingone-mock.invalid/x/as', 'mock')).toBe('Mock: a simulated PingOne inside this lab. Nothing leaves this machine.');
  });
  it('is on every view, presenter mode included', async () => {
    mockServer(BASE_ROUTES(null));
    render(<App />);
    expect(await screen.findByTestId('banner')).toHaveTextContent('Live, not connected: set your PingOne environment in Settings, or switch to Mock.');
    await userEvent.click(screen.getByRole('button', { name: 'Presenter' }));
    expect(screen.getByTestId('banner')).toBeInTheDocument();
    await act(async () => { go('#/playground'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByTestId('banner')).toBeInTheDocument();
  });
});

describe('routes', () => {
  it('parses the hash routes and refuses odd focus values', () => {
    expect(parseRoute('#/run/jar')).toEqual({ view: 'run', card: 'jar' });
    expect(parseRoute('#/settings/p1.environmentId')).toEqual({ view: 'settings', focus: 'p1.environmentId' });
    expect(parseRoute('#/settings/<img>')).toEqual({ view: 'settings', focus: null });
    expect(parseRoute('#/elsewhere')).toEqual({ view: 'shelf' });
  });
});

describe('shelf', () => {
  it('shows the cards in the owner\'s order, with readiness and stories; no PingFederate-only card', async () => {
    mockServer(BASE_ROUTES());
    render(<App />);
    await screen.findByText('Dana links the TV app.');
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(['Sign in (pi.flow)', 'PKCE', 'PAR', 'Signed request object (JAR)', 'Client credentials', 'Token lifecycle: refresh, introspect, revoke',
      'Userinfo', 'Device authorization (RFC 8628)', 'CIBA (start and poll)', 'Token exchange (RFC 8693)', 'Flows API: open and read a pi.flow', 'PingOne Protocol Playground']);
    expect(screen.queryByText(/DPoP|Dynamic client registration|RAR/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ciba.clientSecret' })).toHaveAttribute('href', '#/settings/ciba.clientSecret');
    expect(screen.getByText('Not advertised')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Retail'));
    expect(await screen.findByText('Alex signs in at the screen.')).toBeInTheDocument();
  });

  it('the page background is the Ping dark blue gradient from the shared box tokens, with no colour literal in app.css', () => {
    const css = fs.readFileSync(path.join(here, 'app.css'), 'utf8');
    expect(css).toMatch(/--bg-lab: linear-gradient\(90deg, var\(--box-dark\) 58%, var\(--box-blue\)\);/);
    expect(css).toMatch(/body \{ background: var\(--bg-lab\)/);
    expect(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)).toBeNull();
    expect(css).not.toMatch(/prefers-color-scheme|!important|font-style:\s*italic/);
  });

  it('the banner says live or mock with data-state, as the shared stylesheet expects', async () => {
    render(<App />);
    const banner = await screen.findByTestId('banner');
    expect(banner).toHaveAttribute('data-state');
    expect(banner).not.toHaveAttribute('data-mode');
  });

  it('the vendored shared stylesheet is imported before the lab\'s own', () => {
    const main = fs.readFileSync(path.join(here, 'main.jsx'), 'utf8');
    expect(main.indexOf("import './standalone-ui.css'")).toBeGreaterThan(-1);
    expect(main.indexOf("import './standalone-ui.css'")).toBeLessThan(main.indexOf("import './app.css'"));
    expect(main).toMatch(/@fontsource\/montserrat/);
  });

  it('the Mock/Live toggle shows the mode and switches it through PUT /api/mode', async () => {
    let mode = 'live';
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/config': () => ({ body: { customer: { name: 'PingOne Lab' }, issuer: mode === 'mock' ? 'https://auth.pingone-mock.invalid/e/as' : ISSUER, mode } }), 'PUT /api/mode': (body) => { mode = body.mode; return { body: { mode } }; } });
    render(<App />);
    const live = await screen.findByRole('button', { name: 'Live' });
    await waitFor(() => expect(live).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(screen.getByRole('button', { name: 'Mock' }));
    await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('Mock: a simulated PingOne inside this lab.'));
    expect(screen.getByRole('button', { name: 'Mock' })).toHaveAttribute('aria-pressed', 'true');
    expect(server.calls.filter((c) => c.path === '/api/mode')).toHaveLength(1);
  });

  it('shows who is signed in from /api/me, and signs out', async () => {
    let signedIn = true;
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/me': () => ({ body: signedIn ? { signedIn: true, user: { subject: 'user-id-1', username: 'alice' } } : { signedIn: false } }), 'POST /api/signout': () => { signedIn = false; return { body: { signedIn: false } }; } });
    render(<App />);
    expect(await screen.findByTestId('who')).toHaveTextContent('alice');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(server.calls.some((c) => c.method === 'POST' && c.path === '/api/signout')).toBe(true);
  });

  it('the header Sign in opens the sign-in card and starts its flow, without pressing Run', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'POST /api/signin/start': { state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(window.location.hash).toBe('#/run/signin');
    expect(await screen.findByRole('form', { name: 'Sign-in form' })).toBeInTheDocument();
    expect(server.calls.filter((c) => c.path === '/api/signin/start')).toHaveLength(1);
  });

  it('opening the sign-in card any other way waits for Run', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'POST /api/signin/start': { state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } });
    go('#/run/signin');
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Run' })).toBeEnabled();
    expect(server.calls.some((c) => c.path === '/api/signin/start')).toBe(false);
  });
});

describe('settings', () => {
  const view = {
    settings: { p1: { environmentId: 'env-1', region: 'com', redirectUri: 'http://127.0.0.1:5500/callback' }, ciba: { clientId: 'c1', clientSecret: { set: true }, scope: 'openid' }, jar: { clientId: '', clientSecret: { set: false }, scope: 'openid profile' } },
    issuer: ISSUER,
    ready: { discovery: true },
  };

  it('never prefills a secret, says set or not set, and saves only what changed', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/settings': view, 'PUT /api/settings': view });
    go('#/settings');
    render(<App />);
    const secrets = await screen.findAllByLabelText(/^Client secret/);
    for (const secret of secrets) { expect(secret).toHaveAttribute('type', 'password'); expect(secret).toHaveValue(''); }
    expect(screen.getByText('set')).toBeInTheDocument();
    expect(screen.getByText('not set')).toBeInTheDocument();
    const cibaScope = within(screen.getByRole('group', { name: 'CIBA' })).getByLabelText('Scopes');
    await userEvent.clear(cibaScope);
    await userEvent.type(cibaScope, 'openid profile');
    await userEvent.type(within(screen.getByRole('group', { name: 'Signed request object (JAR)' })).getByLabelText(/^Client secret/), 'new-secret-1');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    const put = server.calls.find((c) => c.method === 'PUT');
    expect(put.body).toEqual({ ciba: { scope: 'openid profile' }, jar: { clientSecret: 'new-secret-1' } });
  });

  it('clears a secret only when asked, and shows the server\'s field error', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/settings': view, 'PUT /api/settings': (body) => (body.p1 ? { status: 400, body: { error: 'invalid_setting', field: 'p1.environmentId', message: 'p1.environmentId must be a PingOne environment id (a UUID)' } } : { body: view }) });
    go('#/settings');
    render(<App />);
    await userEvent.click(await screen.findByLabelText('Clear it'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(server.calls.find((c) => c.method === 'PUT').body).toEqual({ ciba: { clientSecret: null } });
    await userEvent.clear(screen.getByLabelText('Environment ID'));
    await userEvent.type(screen.getByLabelText('Environment ID'), 'not-a-uuid');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('invalid_setting (p1.environmentId): p1.environmentId must be a PingOne environment id (a UUID)')).toBeInTheDocument();
  });

  it('Check PingOne shows the endpoints found, what is not advertised, or the error code and detail', async () => {
    let fail = false;
    mockServer({ ...BASE_ROUTES(), 'GET /api/settings': view, 'POST /api/p1/discovery': () => (fail
      ? { status: 502, body: { error: 'discovery_issuer_mismatch', message: 'The discovery issuer does not match the configured environment' } }
      : { body: { issuer: ISSUER, endpoints: { token: `${ISSUER}/token`, par: null }, features: [{ id: 'dpop', label: 'DPoP', supported: false }], trace: [] } }) });
    go('#/settings');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check PingOne' }));
    expect(await screen.findByText(`Found at ${ISSUER}`)).toBeInTheDocument();
    expect(screen.getByText(`${ISSUER}/token`)).toBeInTheDocument();
    expect(screen.getByText('not advertised')).toBeInTheDocument();
    fail = true;
    await userEvent.click(screen.getByRole('button', { name: 'Check PingOne' }));
    expect(await screen.findByText('discovery_issuer_mismatch')).toBeInTheDocument();
  });

  it('Check PingOne takes the person to its answer, which renders below every setting', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    mockServer({ ...BASE_ROUTES(), 'GET /api/settings': view, 'POST /api/p1/discovery': { issuer: ISSUER, endpoints: {}, features: [], trace: [] } });
    go('#/settings');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check PingOne' }));
    const result = await screen.findByRole('region', { name: 'PingOne check' });
    await waitFor(() => expect(result).toHaveFocus());
    expect(scrolled.mock.contexts).toContain(result);
    delete Element.prototype.scrollIntoView;
  });
});

describe('card run', () => {
  it('lifecycle runs its four steps in order; the refused revoked refresh is a pass, shown in the proof and the live sequence', async () => {
    const t1 = [hop('refresh', 'Refresh: trade the refresh token for new tokens', 'POST', `${ISSUER}/token`, 200)];
    const t2 = [...t1, hop('introspect', 'Introspect the access token', 'POST', `${ISSUER}/introspect`, 200)];
    const t3 = [...t2, hop('revoke', 'Revoke the refresh token', 'POST', `${ISSUER}/revoke`, 200)];
    const t4 = [...t3, hop('refresh-revoked', 'Try the revoked refresh token again', 'POST', `${ISSUER}/token`, 400, { error: 'invalid_grant' })];
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/me': { signedIn: true, user: { subject: 'u1', username: 'alice' } },
      'POST /api/cards/lifecycle/refresh': { outcome: 'accepted', rotated: true, trace: t1 },
      'POST /api/cards/lifecycle/introspect': { outcome: 'accepted', active: true, trace: t2 },
      'POST /api/cards/lifecycle/revoke': { outcome: 'accepted', revoked: 'refresh_token', trace: t3 },
      'POST /api/cards/lifecycle/refresh-revoked': { outcome: 'refused', reason: 'invalid_grant', trace: t4 } });
    go('#/run/lifecycle');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const line = await screen.findByText('PingOne refused the revoked refresh token, as it should: 400 invalid_grant');
    expect(line.closest('li')).toHaveClass('pt-expected');
    expect(within(line.closest('li')).getByText('refused as expected')).toBeInTheDocument();
    expect(screen.getByText(/"Refused as expected" lines are passes/)).toBeInTheDocument();
    expect(screen.getByText('400 as expected')).toHaveClass('s-ok');
    expect(server.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/cards/lifecycle/refresh', '/api/cards/lifecycle/introspect', '/api/cards/lifecycle/revoke', '/api/cards/lifecycle/refresh-revoked']);
    expect(screen.getByRole('region', { name: 'This run, call by call' })).toBeInTheDocument();
    expect(screen.getByText('Revoke the refresh token', { selector: '.trace-title' })).toBeInTheDocument();
  });

  it('a card that needs your tokens says to sign in first; a card PingOne does not advertise cannot run', async () => {
    mockServer(BASE_ROUTES());
    go('#/run/userinfo');
    render(<App />);
    expect(await screen.findByText(/This card works on your own tokens/)).toBeInTheDocument();
    await act(async () => { go('#/run/device'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByText(/Not advertised by your PingOne/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });

  it('stops at an error and shows the server code and detail', async () => {
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/client-credentials/token': { status: 409, body: { error: 'not_configured', message: 'Set clientCredentials.clientId in Settings first' } } });
    go('#/run/clientCredentials');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    expect((await screen.findAllByText('not_configured')).length).toBeGreaterThan(0);
    expect(screen.getByText('The lab stopped: not_configured: Set clientCredentials.clientId in Settings first')).toBeInTheDocument();
  });

  it('a code-flow card asks for credentials in the lab\'s own form, posts them to the lab, and clears the password', async () => {
    let tries = 0;
    const server = mockServer({ ...BASE_ROUTES(),
      'POST /api/cards/pkce/start': { card: 'pkce', state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] },
      'POST /api/cards/pkce/credentials': () => ((tries += 1) === 1
        ? { status: 200, body: { state: 'credentials_required', refused: 'credential_validation_failed', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } }
        : { status: 200, body: { state: 'done', outcome: 'accepted', identity: { subject: 'alice' }, accessToken: { masked: 'eyJhbG...abcd', length: 300, kind: 'JWT', header: { alg: 'ES256' }, claims: { sub: 'alice' } }, trace: [] } }) });
    go('#/run/pkce');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const form = await screen.findByRole('form', { name: 'Sign-in form' });
    await userEvent.type(within(form).getByLabelText('Username'), 'alice');
    await userEvent.type(within(form).getByLabelText('Password'), 'wrong');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Sign in' })).getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/PingOne refused the username or password. Try again./)).toBeInTheDocument();
    expect(within(form).getByLabelText('Password')).toHaveValue('');
    await userEvent.type(within(form).getByLabelText('Password'), 'right');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Sign in' })).getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Done: PingOne issued tokens; the verified ID token names alice.')).toBeInTheDocument();
    expect(screen.getByText('eyJhbG...abcd')).toBeInTheDocument();
    expect(server.calls.filter((c) => c.path === '/api/cards/pkce/credentials').map((c) => c.body)).toEqual([{ username: 'alice', password: 'wrong' }, { username: 'alice', password: 'right' }]);
  });

  it('the sign-in dialog: Sign in waits for both fields; Cancel and Escape close it; Sign in reopens it, the run still waiting', async () => {
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/pkce/start': { card: 'pkce', state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } });
    go('#/run/pkce');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    let dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    const submit = within(dialog).getByRole('button', { name: 'Sign in' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Username'), 'alice');
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Password'), 'x');
    expect(submit).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(within(document.querySelector('.creds-reopen')).getByRole('button', { name: 'Sign in' }));
    dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(within(dialog).getByLabelText('Username')).toHaveValue('alice');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the sign-in dialog does not block the page: Expand all opens every step behind it, Collapse all closes them', async () => {
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/pkce/start': { card: 'pkce', state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED',
      trace: [hop('discovery', 'Discovery', 'GET', `${ISSUER}/.well-known/openid-configuration`, 200), hop('authorize', 'Open', 'GET', `${ISSUER}/authorize`, 200)] } });
    go('#/run/pkce');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(dialog).not.toHaveAttribute('aria-modal');
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    const rows = [...document.querySelectorAll('.proof .trace-list > li > details')];
    expect(rows.length).toBe(2);
    expect(rows.every((d) => d.open)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(rows.some((d) => d.open)).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('a typed user goes to PingOne as login_hint and the sign-in form starts with it', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'POST /api/cards/pkce/start': { card: 'pkce', loginHint: 'alice', state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } });
    go('#/run/pkce');
    render(<App />);
    await userEvent.type(await screen.findByLabelText('User (login_hint)'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    const form = await screen.findByRole('form', { name: 'Sign-in form' });
    expect(within(form).getByLabelText('Username')).toHaveValue('alice');
    expect(server.calls.find((c) => c.path === '/api/cards/pkce/start').body).toEqual({ loginHint: 'alice' });
  });

  it('the password takes a paste, and Show/Hide switches it to plain text and back without losing it (macOS Secure Input)', async () => {
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/pkce/start': { card: 'pkce', state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } });
    go('#/run/pkce');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const form = await screen.findByRole('form', { name: 'Sign-in form' });
    const pass = within(form).getByLabelText('Password');
    pass.focus();
    await userEvent.paste('pasted-secret');
    expect(pass).toHaveValue('pasted-secret');
    expect(pass).toHaveAttribute('type', 'password');
    await userEvent.click(within(form).getByRole('button', { name: 'Show' }));
    expect(pass).toHaveAttribute('type', 'text');
    expect(pass).toHaveValue('pasted-secret');
    expect(pass.getAttribute('value') || '').toBe('');
    await userEvent.click(within(form).getByRole('button', { name: 'Hide' }));
    expect(pass).toHaveAttribute('type', 'password');
  });

  it('CIBA names who will approve, and Run waits until there is someone (typed, or the signed-in user)', async () => {
    const ready = CARDS.map((c) => (c.id === 'ciba' ? { ...c, ready: true, missing: [] } : c));
    let signedIn = false;
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/cards': { cards: ready },
      'GET /api/me': () => ({ body: signedIn ? { signedIn: true, user: { subject: 'user-id-1', username: 'alice' } } : { signedIn: false } }),
      'POST /api/cards/ciba/start': { state: 'pending', trace: [] }, 'POST /api/cards/ciba/poll': { state: 'approved', trace: [] } });
    go('#/run/ciba');
    const { unmount } = render(<App />);
    const run = await screen.findByRole('button', { name: 'Run' });
    expect(run).toBeDisabled();
    expect(screen.getByText(/Type the user who should approve, or/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('User (login_hint)'), 'bob');
    expect(screen.getByText('bob', { selector: 'strong' })).toBeInTheDocument();
    expect(run).toBeEnabled();
    unmount();
    signedIn = true;
    render(<App />);
    expect(await screen.findByText('alice', { selector: '#ciba-who strong' })).toBeInTheDocument();
    expect(screen.getByLabelText('User (login_hint)')).toHaveAttribute('placeholder', 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(server.calls.some((c) => c.path === '/api/cards/ciba/start')).toBe(true));
  });

  it('CIBA says PingOne asked the user through its own authenticator, offers no approve button, and the poll finishes', async () => {
    const ready = CARDS.map((c) => (c.id === 'ciba' ? { ...c, ready: true, missing: [] } : c));
    let polls = 0;
    const pending = { state: 'pending', loginHint: 'bob', bindingMessage: 'PAY-42', interval: 1, trace: [] };
    mockServer({ ...BASE_ROUTES(), 'GET /api/cards': { cards: ready },
      'POST /api/cards/ciba/start': pending,
      'POST /api/cards/ciba/poll': () => ({ body: (polls += 1) > 1 ? { state: 'approved', identity: { subject: 'bob' }, trace: [] } : pending }) });
    go('#/run/ciba');
    render(<App />);
    await userEvent.type(await screen.findByLabelText('User (login_hint)'), 'bob');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    const panel = await screen.findByRole('region', { name: 'Waiting for approval' });
    expect(within(panel).getByText('PingOne asked bob to approve')).toBeInTheDocument();
    expect(within(panel).getByText('PAY-42')).toBeInTheDocument();
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(await screen.findByText(/The request ended: approved/, {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('device shows the user code and PingOne\'s verification link while it polls', async () => {
    const ready = CARDS.map((c) => (c.id === 'device' ? { ...c, advertised: true } : c));
    let polls = 0;
    const pending = { state: 'pending', userCode: 'WDJB-MJHT', verificationUri: 'https://auth.pingone.example/env-1/device', verificationUriComplete: 'https://auth.pingone.example/env-1/device?user_code=WDJB-MJHT', interval: 1, trace: [] };
    mockServer({ ...BASE_ROUTES(), 'GET /api/cards': { cards: ready },
      'POST /api/cards/device/start': pending,
      'POST /api/cards/device/poll': () => ({ body: (polls += 1) > 1 ? { state: 'approved', identity: { subject: 'u1' }, trace: [] } : pending }) });
    go('#/run/device');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const panel = await screen.findByRole('region', { name: 'Enter the code' });
    expect(within(panel).getByTestId('user-code')).toHaveTextContent('WDJB-MJHT');
    const link = within(panel).getByRole('link', { name: 'https://auth.pingone.example/env-1/device' });
    expect(link).toHaveAttribute('href', 'https://auth.pingone.example/env-1/device?user_code=WDJB-MJHT');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    expect(await screen.findByText(/The request ended: approved/, {}, { timeout: 4000 })).toBeInTheDocument();
  });
});

describe('playground', () => {
  it('CIBA takes a typed user when nobody is signed in and sends it as login_hint', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/cards': { cards: CARDS.map((c) => (c.id === 'ciba' ? { ...c, ready: true, missing: [] } : c)) }, 'POST /api/cards/ciba/start': { status: 400, body: { error: 'stop_here' } } });
    go('#/playground');
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Flows' });
    await userEvent.click(within(nav).getByRole('button', { name: /CIBA/ }));
    const runAll = screen.getByRole('button', { name: 'Run all' });
    expect(runAll).toBeDisabled();
    await userEvent.type(screen.getByLabelText('User (login_hint)'), 'bob');
    expect(runAll).toBeEnabled();
    await userEvent.click(runAll);
    await waitFor(() => expect(server.calls.find((c) => c.path === '/api/cards/ciba/start')?.body?.loginHint).toBe('bob'));
  });

  it('lists every flow and executes exactly one step at a time', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'POST /api/cards/lifecycle/refresh': { outcome: 'accepted', trace: [hop('refresh', 'Refresh', 'POST', `${ISSUER}/token`, 200)] } });
    go('#/playground');
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Flows' });
    expect(within(nav).getAllByRole('button')).toHaveLength(12);
    await userEvent.click(within(nav).getByRole('button', { name: /Token lifecycle/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Execute step 1: Refresh: trade the refresh token for new tokens' }));
    expect(await screen.findByText('PingOne accepted the refresh: 200')).toBeInTheDocument();
    expect(server.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/cards/lifecycle/refresh']);
    expect(screen.getByRole('region', { name: 'Step 1 raw' })).toBeInTheDocument();
  });
});

describe('no redirect, no other host', () => {
  it('no source file navigates the window or calls fetch with an absolute URL', () => {
    const files = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.|testApi|testSetup/.test(e.name)) files.push(p); } };
    walk(here);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      expect([f, /location\.(href|assign|replace)\s*[=(]|window\.open\(|location\s*=/.test(text)]).toEqual([f, false]);
      expect([f, /fetch\(\s*['"`]https?:/.test(text)]).toEqual([f, false]);
    }
  });
});

describe('pi.flow guide', () => {
  it('explains the idea, steps, statuses and when to use it, then the fields of the answer the run got back', async () => {
    const answer = { id: '<flow id>', status: 'USERNAME_PASSWORD_REQUIRED', _links: { 'usernamePassword.check': { href: 'x' }, self: { href: 'x' } }, resumeUrl: 'https://auth.example/env/as/resume?flowId=<flow id>', expiresAt: '2026-10-30T19:02:38.378Z', extra: 1 };
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/piflow/open': { status: answer.status, actions: ['usernamePassword.check'], trace: [hop('authorize', 'Open', 'GET', 'https://auth.example/as/authorize', 200, answer)] } });
    go('#/run/piflow');
    render(<App />);
    const guide = await screen.findByRole('region', { name: 'How pi.flow works' });
    for (const h of ['1. The idea', '2. The steps', '3. The answer you just got', '4. Statuses', '5. When to use it']) expect(within(guide).getByRole('heading', { name: h })).toBeInTheDocument();
    expect(within(guide).getByText(/Press Run/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(within(guide).queryByText(/Press Run/)).toBeNull());
    const statusRow = within(guide).getByRole('row', { name: /USERNAME_PASSWORD_REQUIRED/ });
    expect(within(statusRow).getByText('your answer')).toBeInTheDocument();
    expect(within(guide).getByText('2026-10-30T19:02:38.378Z')).toBeInTheDocument();
    expect(within(guide).getAllByText('not in this answer').length).toBeGreaterThan(0);
    expect(within(guide).getByText(/Also in this answer: extra/)).toBeInTheDocument();
  });
});

describe('mock labels', () => {
  it('a mock-issued token and a mock hop say mock', async () => {
    const { TokenView, TraceList } = await import('./Proof.jsx');
    render(<><TokenView label="Access token" token={{ masked: 'eyJhbG...abcd', length: 300, kind: 'JWT', claims: { sub: 'x' }, mock: true }} />
      <TraceList trace={[{ id: 'discovery', title: 'Read PingOne discovery', mock: true, request: { method: 'GET', url: 'https://auth.pingone-mock.invalid/e/as/.well-known/openid-configuration' }, response: { status: 200, body: {} } }]} /></>);
    expect(screen.getAllByText('mock')).toHaveLength(2);
  });

  it('a mock token is shown whole and labelled; a live token stays masked', async () => {
    const { TokenView } = await import('./Proof.jsx');
    // Built at run time: a literal JWT in the source is flagged by gitleaks, even a fake one.
    const whole = [btoa('{"alg":"ES256"}'), btoa('{"sub":"alice"}'), btoa('signature')].join('.');
    const { unmount } = render(<TokenView label="Access token" token={{ value: whole, length: whole.length, kind: 'JWT', claims: { sub: 'alice' }, mock: true }} />);
    expect(screen.getByText(whole)).toBeInTheDocument();
    expect(screen.getByText('mock token, shown whole')).toBeInTheDocument();
    unmount();
    render(<TokenView label="Access token" token={{ masked: 'eyJhbG...abcd', length: 300, kind: 'JWT', claims: { sub: 'alice' } }} />);
    expect(screen.getByText('eyJhbG...abcd')).toBeInTheDocument();
    expect(screen.queryByText(whole)).toBeNull();
    expect(screen.getByText('masked')).toBeInTheDocument();
  });

  it('in mock mode the sign-in dialog names the mock demo user and fills the username', async () => {
    const Credentials = (await import('./views/Credentials.jsx')).default;
    mockServer({ 'GET /api/config': { mode: 'mock', mockSignin: { allowed: true, username: 'alice', password: 'correct-horse-battery' } } });
    render(<Credentials onSubmit={() => {}} />);
    expect(await screen.findByTestId('mock-user')).toHaveTextContent('alice / correct-horse-battery');
    expect(screen.getByLabelText('Username')).toHaveValue('alice');
  });
});

describe('workspace (rule 13)', () => {
  afterEach(() => { window.history.replaceState(null, '', '/'); });
  it('names the workspace on every call and shows it in the header', async () => {
    window.history.replaceState(null, '', '/?workspace=team-a');
    const { impl } = mockServer(BASE_ROUTES(null));
    render(<App />);
    expect(await screen.findByTestId('workspace')).toHaveValue('team-a');
    expect(impl.mock.calls.length).toBeGreaterThan(0);
    expect(impl.mock.calls.every(([, init]) => init.headers['x-lab-workspace'] === 'team-a')).toBe(true);
  });
  it('uses "default" when none is chosen and refuses a bad name', async () => {
    window.history.replaceState(null, '', '/?workspace=Not%20Valid!');
    const { impl } = mockServer(BASE_ROUTES(null));
    render(<App />);
    expect(await screen.findByTestId('workspace')).toHaveValue('default');
    expect(impl.mock.calls.every(([, init]) => init.headers['x-lab-workspace'] === 'default')).toBe(true);
    await userEvent.clear(screen.getByTestId('workspace'));
    await userEvent.type(screen.getByTestId('workspace'), 'Bad Name');
    expect(screen.getByRole('button', { name: 'Switch' })).toBeDisabled();
  });
});
