import crypto from 'node:crypto';

// Server-side sessions, in memory only. The browser holds an unguessable id in an HttpOnly, SameSite=Strict
// cookie; tokens, PingOne's session cookies, device codes and pending runs live here and never leave the server.

export const COOKIE = 'p1lab_sid';
// Workspace id (rule 13): the header X-Lab-Workspace names the caller's workspace, default "default". Sessions, runs,
// results and traces live inside one workspace; a browser holds one session cookie per workspace, so two workspaces
// in one browser never share a session. Reset clears one workspace and no other.
export const WORKSPACE_HEADER = 'x-lab-workspace';
export const DEFAULT_WORKSPACE = 'default';
export const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const cookieName = (workspace) => (workspace === DEFAULT_WORKSPACE ? COOKIE : `${COOKIE}_${workspace}`);
const ID = /^[A-Za-z0-9_-]{43}$/;
export const MAX_SESSIONS = 200;
export const IDLE_TTL_MS = 8 * 60 * 60 * 1000;

export function emptyState() {
  return { user: null, p1Cookies: {}, p1CookiesFor: null, runs: {}, results: {}, tokens: {}, ciba: null, device: null };
}

export function createSessions({ now = Date.now, max = MAX_SESSIONS, secure = false } = {}) {
  const live = new Map(); // id -> session; insertion order = least recently used first

  // The workspace a request names, or null when the header is not a valid workspace id.
  function workspaceOf(req) {
    const raw = req.headers[WORKSPACE_HEADER];
    if (raw === undefined) return DEFAULT_WORKSPACE;
    return typeof raw === 'string' && WORKSPACE.test(raw) ? raw : null;
  }

  function readId(header, name_) {
    if (typeof header !== 'string' || header.length > 4096) return null;
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === name_) {
        const value = rest.join('=');
        return ID.test(value) ? value : null;
      }
    }
    return null;
  }

  const newId = () => crypto.randomBytes(32).toString('base64url');
  // Secure once the lab serves https, so the cookie never travels over plain http.
  const setCookie = (res, id, workspace) => res.append('Set-Cookie', `${cookieName(workspace)}=${id}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`);

  // Over the cap, anonymous sessions go first (least recently used first); a signed-in one only when none is left.
  function evict() {
    while (live.size > max) {
      let victim = null;
      for (const [id, s] of live) { if (!s.user) { victim = id; break; } }
      live.delete(victim ?? live.keys().next().value);
    }
  }

  // Looks up the caller's session by its cookie. A session is created only on a write (which has already passed the
  // same-origin checks), never on a GET: cross-site GETs (an <img> tag) cannot fill the store. A GET without a live
  // session gets an empty, unstored one. A client-chosen id that is not live is never adopted.
  function middleware(req, res, next) {
    const workspace = workspaceOf(req);
    if (!workspace) return res.status(400).json({ error: 'bad_workspace' });
    const id = readId(req.headers.cookie, cookieName(workspace));
    let session = id ? live.get(id) : null;
    // A session only ever answers inside the workspace it was made in.
    if (session && session.workspace !== workspace) session = null;
    if (session && now() - session.lastSeen > IDLE_TTL_MS) { live.delete(id); session = null; }
    if (!session) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        req.session = { id: null, workspace, lastSeen: now(), ...emptyState() };
        return next();
      }
      session = { id: newId(), workspace, lastSeen: now(), ...emptyState() };
      setCookie(res, session.id, workspace);
    }
    session.lastSeen = now();
    live.delete(session.id);
    live.set(session.id, session);
    evict();
    req.session = session;
    return next();
  }

  // On an accepted sign-in the session gets a new id: the old one (which someone else may have planted) is dead.
  function rotate(session, res) {
    live.delete(session.id);
    session.id = newId();
    live.set(session.id, session);
    setCookie(res, session.id, session.workspace);
  }

  // Sign-out: the whole session goes, PingOne's cookies and every token with it.
  function destroy(session) { live.delete(session.id); }

  // Reset: clears every card's runs, results and tokens; keeps the sign-in.
  function reset(session) {
    const keep = { user: session.user, p1Cookies: session.p1Cookies, p1CookiesFor: session.p1CookiesFor, signin: session.tokens.signin };
    Object.assign(session, emptyState(), { user: keep.user, p1Cookies: keep.p1Cookies, p1CookiesFor: keep.p1CookiesFor }, { tokens: {} });
    delete session.signin;
    if (keep.signin) session.tokens.signin = keep.signin;
    return { kept: keep.user ? 'sign-in' : null };
  }

  // Reset of a whole workspace: every session in it is cleared the same way, and no session of another workspace is touched.
  function resetWorkspace(workspace) {
    let count = 0;
    for (const s of live.values()) { if (s.workspace === workspace) { reset(s); count += 1; } }
    return count;
  }

  return { middleware, destroy, reset, resetWorkspace, rotate, size: () => live.size, has: (id) => live.has(id) };
}
