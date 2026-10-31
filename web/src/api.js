// Same-origin calls to the lab's own server, never any other host. The server is the only thing that talks to
// PingOne; the page never navigates to it.
// The workspace (rule 13): ?workspace=<id> in the page URL, else the one remembered in this browser, else "default".
// Every call names it, so sessions, runs and traces stay inside it, and Reset clears this workspace only.
export const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function currentWorkspace() {
  let fromUrl = null;
  let remembered = null;
  try { fromUrl = new URLSearchParams(window.location.search).get('workspace'); } catch { /* no location */ }
  try { remembered = window.localStorage.getItem('p1lab-workspace'); } catch { /* storage may be blocked */ }
  return [fromUrl, remembered].find((w) => typeof w === 'string' && WORKSPACE.test(w)) || 'default';
}

export async function call(method, path, body) {
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'x-lab-workspace': currentWorkspace(), ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    let data = null;
    try { data = await response.json(); } catch { /* empty or non-JSON body */ }
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'network_error', message: 'The lab server did not answer' } };
  }
}

export const api = {
  config: () => call('GET', '/api/config'),
  setMode: (mode) => call('PUT', '/api/mode', { mode }),
  cards: () => call('GET', '/api/cards'),
  me: () => call('GET', '/api/me'),
  signOut: () => call('POST', '/api/signout'),
  settings: () => call('GET', '/api/settings'),
  saveSettings: (patch) => call('PUT', '/api/settings', patch),
  discovery: () => call('POST', '/api/p1/discovery'),
  stories: () => call('GET', '/api/stories'),
  story: (vertical) => call('GET', `/api/stories/${encodeURIComponent(vertical)}`),
  reset: () => call('POST', '/api/reset'),
};
