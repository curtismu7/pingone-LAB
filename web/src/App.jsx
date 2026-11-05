import { useCallback, useEffect, useState } from 'react';
import { api, currentWorkspace, WORKSPACE } from './api.js';
import Shelf from './views/Shelf.jsx';
import RunView from './views/RunView.jsx';
import Settings from './views/Settings.jsx';
import Playground from './views/Playground.jsx';
import ShelfLink from "./components/ShelfLink.jsx";

// Hash routes: #/ (shelf), #/run/<card>, #/settings[/<section.field>], #/playground.
export function parseRoute(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'run' && parts[1]) return { view: 'run', card: parts[1] };
  if (parts[0] === 'settings') return { view: 'settings', focus: parts[1] && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z]+$/.test(parts[1]) ? parts[1] : null };
  if (parts[0] === 'playground') return { view: 'playground' };
  return { view: 'shelf' };
}

// Rule 2: says on every view, presenter mode included, which mode the lab is in and what that means.
export function bannerText(issuer, mode) {
  if (mode === 'mock') return 'Mock: a simulated PingOne inside this lab. Nothing leaves this machine.';
  return issuer
    ? `Live: every call goes to your PingOne environment at ${issuer}. Nothing here is simulated.`
    : 'Live, not connected: set your PingOne environment in Settings, or switch to Mock.';
}

export function viewTitle(route, cards, name = 'PingOne Lab') {
  const lab = name || 'PingOne Lab';
  if (route.view === 'settings') return `Settings - ${lab}`;
  if (route.view === 'playground') return `Protocol Playground - ${lab}`;
  if (route.view === 'run') { const card = cards.find((c) => c.id === route.card); return `${card ? card.title : 'Unknown card'} - ${lab}`; }
  return `Shelf - ${lab}`;
}

const THEMES = ['auto', 'light', 'dark'];
const read = (key, fallback) => { try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { window.localStorage.setItem(key, value); } catch { /* storage may be blocked */ } };

export default function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const [config, setConfig] = useState(null);
  const [cards, setCards] = useState([]);
  const [me, setMe] = useState({ signedIn: false });
  const [verticals, setVerticals] = useState([]);
  const [vertical, setVertical] = useState(() => read('p1lab-vertical', ''));
  const [story, setStory] = useState(null);
  const [theme, setTheme] = useState(() => (THEMES.includes(read('p1lab-theme', 'auto')) ? read('p1lab-theme', 'auto') : 'auto'));
  const [presenter, setPresenter] = useState(() => new URLSearchParams(window.location.search).get('present') === '1');
  const [loadError, setLoadError] = useState(null);
  // Set by the header's Sign in: the sign-in card starts its flow as soon as it shows, instead of waiting for Run.
  const [signInRequested, setSignInRequested] = useState(false);
  const signIn = () => { setSignInRequested(true); window.location.hash = '#/run/signin'; };

  const refresh = useCallback(async () => {
    const [c, k, m] = await Promise.all([api.config(), api.cards(), api.me()]);
    if (!c.ok || !k.ok) { setLoadError(c.data?.error || k.data?.error || 'the lab server did not answer'); return; }
    setLoadError(null);
    setConfig(c.data);
    setCards(k.data.cards);
    setMe(m.ok ? m.data : { signedIn: false });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onHash = () => { setRoute(parseRoute(window.location.hash)); window.scrollTo?.(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    api.stories().then((r) => { if (r.ok) { setVerticals(r.data.verticals); setVertical((v) => (r.data.verticals.some((x) => x.id === v) ? v : r.data.default)); } });
  }, []);
  useEffect(() => {
    if (!vertical) return;
    write('p1lab-vertical', vertical);
    api.story(vertical).then((r) => setStory(r.ok ? r.data : null));
  }, [vertical]);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    write('p1lab-theme', theme);
  }, [theme]);
  // A customer.config accent (checked on the server for white text at 4.5:1) replaces Ping red at run time, in both
  // themes. Without one, the shared Ping red stands.
  useEffect(() => {
    const root = document.documentElement;
    const accent = config?.customer?.customAccent ? config.customer.accent : null;
    for (const prop of ['--accent', '--accent-gradient']) {
      if (accent) root.style.setProperty(prop, accent); else root.style.removeProperty(prop);
    }
  }, [config]);
  // The workspace this tab works in. Switching remembers it, drops ?workspace= from the URL, and reloads: each
  // workspace has its own session, runs and traces on the server.
  const workspace = currentWorkspace();
  const [workspaceDraft, setWorkspaceDraft] = useState(workspace);
  const switchWorkspace = (event) => {
    event.preventDefault();
    const next = workspaceDraft.trim().toLowerCase();
    if (!WORKSPACE.test(next) || next === workspace) return;
    write('p1lab-workspace', next);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    window.location.reload();
  };
  const [modeBusy, setModeBusy] = useState(false);
  // Rule 19: Real is disabled with the server's reason while the live settings are incomplete. The fields ride
  // /api/config (refetched by refresh()), so the toggle is always in sync with the server's answer.
  const realAvailable = config ? config.realAvailable !== false : null; // null = not loaded yet
  const realReason = config?.realReason || null;
  const switchMode = async (next) => {
    if (next === config?.mode || modeBusy) return;
    if (next === 'live' && realAvailable === false) return; // Real is disabled with the reason; the button is too
    setModeBusy(true);
    await api.setMode(next);
    setModeBusy(false);
    await refresh();
  };
  useEffect(() => {
    if (!presenter) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPresenter(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenter]);

  // The window title names the view, then the lab.
  useEffect(() => { document.title = viewTitle(route, cards, config?.customer?.name); }, [route, cards, config]);

  const signOut = async () => { await api.signOut(); await refresh(); };
  const skipToMain = (event) => { event.preventDefault(); document.getElementById('main')?.focus(); };
  const card = route.view === 'run' ? cards.find((c) => c.id === route.card && c.kind === 'flow') : null;
  const name = config?.customer?.name || 'PingOne Lab';
  // PingOne's subject is a user id; the username reads better in the header and as a default login_hint.
  const signedInAs = me.signedIn ? (me.user?.username || me.user?.subject) : null;

  return (
    <div className={`app${presenter ? ' presenter' : ''}`}>
      {/* The skip link never changes the hash: the router reads the hash, so "#main" would leave the current view. */}
      <a className="skip" href="#main" onClick={skipToMain}>Skip to content</a>
      <div className="banner" role="status" data-testid="banner" data-state={config?.mode === 'mock' ? 'mock' : 'live'}>
        {bannerText(config?.issuer, config?.mode)}
      </div>
      <header className="top">
        <div className="brand">
          <img className="brand__logo" src="/ping-logo.png" alt="Ping Identity" width="36" height="36" />
          <h1><a href="#/">{name}</a></h1>
        <ShelfLink headers={() => ({ 'x-lab-workspace': currentWorkspace() })} />
          {config?.customer?.tagline && <p className="tagline">{config.customer.tagline}</p>}
        </div>
        <nav className="nav" aria-label="Main">
          <a href="#/" aria-current={route.view === 'shelf' ? 'page' : undefined}>Shelf</a>
          <a href="#/playground" aria-current={route.view === 'playground' ? 'page' : undefined}>Playground</a>
          <a href="#/settings" aria-current={route.view === 'settings' ? 'page' : undefined}>Settings</a>
        </nav>
        <div className="prefs">
          <div className="mode-toggle" role="group" aria-label="Mode" data-testid="mode">
            {[
              ['mock', 'Mock', false],
              ['live', 'Real', true],
            ].map(([m, label, isReal]) => {
              const off = modeBusy || (isReal && realAvailable === false);
              const why = isReal && realAvailable === false && realReason ? realReason : undefined;
              return (
                <button key={m} type="button" className="mode-toggle__button" aria-pressed={(config?.mode || 'mock') === m} disabled={off} title={why} onClick={() => switchMode(m === 'live' ? 'live' : 'mock')} data-testid={`mode-${m === 'live' ? 'real' : 'mock'}`}>
                  {label}
                </button>
              );
            })}
          </div>
          <form className="workspace" onSubmit={switchWorkspace} aria-label="Workspace">
            <label className="inline">Workspace
              <input type="text" value={workspaceDraft} onChange={(e) => setWorkspaceDraft(e.target.value)} maxLength={32} spellCheck={false} autoComplete="off" title="Lowercase letters, digits and hyphens, up to 32. Each workspace has its own sign-in, runs and traces." data-testid="workspace" />
            </label>
            <button type="submit" disabled={!WORKSPACE.test(workspaceDraft.trim().toLowerCase()) || workspaceDraft.trim().toLowerCase() === workspace}>Switch</button>
          </form>
          <label className="inline">Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              {THEMES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
            </select>
          </label>
          <button type="button" aria-pressed={presenter} onClick={() => setPresenter((p) => !p)}>Presenter</button>
        </div>
        <div className="who">
          {me.signedIn
            ? <><span>Signed in as <strong data-testid="who">{signedInAs}</strong></span><button type="button" onClick={signOut}>Sign out</button></>
            : <button type="button" className="primary" onClick={signIn}>Sign in</button>}
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {loadError && <p className="pt pt-error" role="alert">Could not load the lab: {loadError}</p>}
        {route.view === 'shelf' && <Shelf cards={cards} story={story} verticals={verticals} vertical={vertical} onVertical={setVertical} />}
        {route.view === 'run' && (card
          ? <RunView key={card.id} card={card} story={story?.cards?.[card.id]} onChanged={refresh} signedInAs={signedInAs}
              autoStart={card.id === 'signin' && signInRequested} onAutoStarted={() => setSignInRequested(false)} />
          : cards.length > 0 && <p>Unknown card. <a href="#/">Back to the shelf</a></p>)}
        {route.view === 'settings' && <Settings focus={route.focus} onChanged={refresh} warnings={config?.customer?.warnings || []} />}
        {route.view === 'playground' && <Playground cards={cards} onChanged={refresh} signedInAs={signedInAs} mock={config ? config.mode === 'mock' : null} />}
      </main>
      <footer className="foot">
        <p>Live tokens are shown masked (first 6 and last 4 characters) and mock tokens whole, each with its decoded header and claims; secrets never leave the lab server. <a href="#/settings">Settings</a></p>
      </footer>
    </div>
  );
}
