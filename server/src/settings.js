import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MOCK_ORIGIN, ENV_ID as MOCK_ENV_ID, MOCK_CLIENTS } from './mockp1.js';

// Which PingOne environment this lab talks to, and per card the client ids and secrets. One file, mode 600:
// ~/.config/demo-kit/pingone-lab/pingone-lab.json, in a folder of its own so Docker mounts nothing else
// (P1LAB_SETTINGS_FILE overrides the path, for tests and the container). The environment id and region fall back to
// the family's one shared settings file, ~/Development/.env (PINGONE_ENVIRONMENT_ID and PINGONE_REGION; read only;
// STANDALONE_ENV or P1LAB_SHARED_FILE overrides the path), so a lab on a Mac that already has a PingOne environment
// starts with it. Only those two keys are ever read from it: no worker or admin credential belongs there.
// Secrets are write-only: publicView() says only whether each one is set; nothing here ever logs a value.

export const DEFAULT_FILE = path.join(os.homedir(), '.config', 'demo-kit', 'pingone-lab', 'pingone-lab.json');
export const DEFAULT_ENV_FILE = path.join(os.homedir(), 'Development', '.env');
export const DEFAULT_PORT = 5500;
// mock: every card runs against the lab's in-process mock PingOne and nothing leaves the machine. live: the PingOne
// environment set here. Stored in the settings file; unset means live when an environment is already configured.
export const MODES = ['mock', 'live'];
// PingOne regions and their top-level domains (auth.pingone.<tld>).
export const REGIONS = ['com', 'eu', 'ca', 'asia'];
const REGION_ALIASES = { na: 'com', us: 'com', com: 'com', eu: 'eu', ca: 'ca', ap: 'asia', asia: 'asia', au: 'asia' };

// kind: env = a PingOne environment id (UUID); region = com | eu | ca | asia; redirect = https, or http on loopback
// (PingOne never visits it under pi.flow); id = a client id; scope = space-separated scopes; text; secret.
const client = (extra = {}) => ({ clientId: { kind: 'id' }, clientSecret: { kind: 'secret' }, ...extra });
export const SCHEMA = {
  p1: { environmentId: { kind: 'env' }, region: { kind: 'region', default: 'com' }, redirectUri: { kind: 'redirect' } }, // default: http://127.0.0.1:<the lab's port>/callback
  signin: client({ scope: { kind: 'scope', default: 'openid profile email address phone' } }),
  pkce: client({ scope: { kind: 'scope', default: 'openid profile email address phone' } }),
  par: client({ scope: { kind: 'scope', default: 'openid profile email address phone' } }),
  // JAR: the request object is signed HS256 with the client secret, so the secret is required.
  jar: client({ scope: { kind: 'scope', default: 'openid profile email address phone' } }),
  // Client credentials: PingOne grants only scopes of a custom resource assigned to the app, so no default scope.
  clientCredentials: client({ scope: { kind: 'scope' } }),
  device: client({ scope: { kind: 'scope', default: 'openid profile' } }),
  ciba: client({ scope: { kind: 'scope', default: 'openid profile' } }),
  tokenExchange: {
    exchangeClientId: { kind: 'id' },
    exchangeClientSecret: { kind: 'secret' },
    scope: { kind: 'scope' },
    // Optional actor: a client-credentials token of this app goes in as actor_token.
    actorClientId: { kind: 'id' },
    actorClientSecret: { kind: 'secret' },
    actorScope: { kind: 'scope' },
    // Optional: when set, the exchanged token must name this audience.
    audience: { kind: 'text' },
  },
};

// What each card needs before it can run.
const ENV = ['p1', 'environmentId'];
export const REQUIRED = {
  discovery: [ENV],
  signin: [ENV, ['signin', 'clientId']],
  pkce: [ENV, ['pkce', 'clientId']],
  par: [ENV, ['par', 'clientId']],
  jar: [ENV, ['jar', 'clientId'], ['jar', 'clientSecret']],
  clientCredentials: [ENV, ['clientCredentials', 'clientId'], ['clientCredentials', 'clientSecret']],
  lifecycle: [ENV, ['signin', 'clientId']],
  userinfo: [ENV, ['signin', 'clientId']],
  device: [ENV, ['device', 'clientId']],
  ciba: [ENV, ['ciba', 'clientId'], ['ciba', 'clientSecret']],
  tokenExchange: [ENV, ['tokenExchange', 'exchangeClientId'], ['tokenExchange', 'exchangeClientSecret']],
  piflow: [ENV, ['signin', 'clientId']],
};

export class SettingsError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkUrl(value, { allowLoopbackHttp }) {
  let url;
  try { url = new URL(value); } catch { return 'is not a URL'; }
  if (url.username || url.password) return 'must not carry credentials';
  if (url.hash) return 'must not have a fragment';
  if (url.protocol === 'https:') return null;
  if (allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
  return allowLoopbackHttp ? 'must be https (http only on loopback)' : 'must be https';
}

function validate(kind, value, name) {
  if (typeof value !== 'string') throw new SettingsError(name, `${name} must be text`);
  const max = kind === 'secret' ? 1024 : 512;
  if (!value || value.length > max || CONTROL.test(value)) throw new SettingsError(name, `${name} must be 1 to ${max} characters, no control characters`);
  let problem = null;
  if (kind === 'redirect' || kind === 'link') problem = checkUrl(value, { allowLoopbackHttp: true });
  if (kind === 'id' && !/^[\x21-\x7e]{1,256}$/.test(value)) problem = 'must be printable ASCII with no spaces';
  if (kind === 'env' && !UUID.test(value)) problem = 'must be a PingOne environment id (a UUID)';
  if (kind === 'region' && !REGIONS.includes(value)) problem = `must be one of ${REGIONS.join(', ')}`;
  if (kind === 'scope' && !/^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(value)) problem = 'must be space-separated scope tokens';
  if (problem) throw new SettingsError(name, `${name} ${problem}`);
  return kind === 'env' ? value.toLowerCase() : value;
}

// A symlinked settings file is refused: writes and chmod would land wherever the link points.
function refuseSymlink(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return false; }
  if (stat.isSymbolicLink()) throw new SettingsError('file', 'The settings file is a symbolic link; refusing to use it');
  return true;
}

// Written to an unpredictable temp file created exclusively (O_EXCL: never an existing file or link) in the same
// directory, mode 600 set on the open descriptor, then renamed over the target.
function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  refuseSymlink(file);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
}

// The family's shared .env, read only: KEY=value lines, '#' comments, optional quotes. Only PINGONE_ENVIRONMENT_ID and
// PINGONE_REGION are taken. Anything missing, unreadable or invalid is ignored.
function readShared(file) {
  if (!file) return {};
  let text;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return {};
    text = fs.readFileSync(file, 'utf8');
  } catch { return {}; }
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(PINGONE_ENVIRONMENT_ID|PINGONE_REGION)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) found[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const out = {};
  if (UUID.test(found.PINGONE_ENVIRONMENT_ID || '')) out.environmentId = found.PINGONE_ENVIRONMENT_ID.toLowerCase();
  const region = REGION_ALIASES[String(found.PINGONE_REGION || '').toLowerCase()];
  if (region) out.region = region;
  return out;
}

export function createSettings({ file = process.env.P1LAB_SETTINGS_FILE || DEFAULT_FILE, sharedFile = process.env.P1LAB_SHARED_FILE ?? process.env.STANDALONE_ENV ?? DEFAULT_ENV_FILE, port = DEFAULT_PORT } = {}) {
  const defaults = { p1: { redirectUri: `http://127.0.0.1:${port}/callback`, ...readShared(sharedFile) } };
  let values = {};
  let storedMode = null;

  function load() {
    let parsed = {};
    // A missing file is an empty lab. A file that is a link, or is not JSON, stops the lab: it is never silently
    // ignored and then overwritten (the owner fixes or removes it).
    if (refuseSymlink(file)) {
      const stat = fs.statSync(file);
      // A settings file anyone else can read is narrowed to the owner before it is used.
      if ((stat.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
        throw new SettingsError('file', `The settings file ${file} is not valid JSON; fix or remove it`);
      }
    }
    values = {};
    storedMode = MODES.includes(parsed?.mode) ? parsed.mode : null;
    const stored = parsed && typeof parsed.values === 'object' && parsed.values ? parsed.values : {};
    // Only known fields that still validate are kept; anything else in the file is ignored.
    for (const [section, fields] of Object.entries(SCHEMA)) {
      for (const [name, spec] of Object.entries(fields)) {
        const raw = stored?.[section]?.[name];
        if (raw === undefined) continue;
        try { (values[section] ||= {})[name] = validate(spec.kind, raw, `${section}.${name}`); } catch { /* dropped */ }
      }
    }
  }
  load();

  // The configured (live) value of one field: stored, else its default, else ''.
  function liveValue(section, name) {
    const stored = values[section]?.[name];
    if (stored !== undefined) return stored;
    return defaults[section]?.[name] ?? SCHEMA[section]?.[name]?.default ?? '';
  }

  const mode = () => storedMode || (liveValue('p1', 'environmentId') ? 'live' : 'mock');

  // The value the cards use. In mock mode the environment and every client come from the mock; the live settings
  // stay untouched in the file and on the Settings page.
  function value(section, name) {
    if (mode() === 'mock') {
      if (section === 'p1' && name === 'environmentId') return MOCK_ENV_ID;
      if (section === 'p1' && name === 'region') return 'com';
      const mock = MOCK_CLIENTS[section];
      // Clients and their secrets always come from the mock; so does every other field of the cards whose settings
      // only make sense for the mock's own apps (client credentials scope, token exchange audience and scopes).
      if (mock && (name !== 'scope' || ['clientCredentials', 'tokenExchange'].includes(section))) return mock[name] ?? '';
    }
    return liveValue(section, name);
  }

  function section(name) {
    const out = {};
    for (const field of Object.keys(SCHEMA[name])) out[field] = value(name, field);
    return out;
  }

  const ready = (card) => (REQUIRED[card] || []).every(([s, f]) => Boolean(value(s, f)));
  // Which settings a card still needs, as "section.field" names (the Settings page anchors on them).
  const missing = (card) => (REQUIRED[card] || []).filter(([s, f]) => !value(s, f)).map(([s, f]) => `${s}.${f}`);

  // Safe for the page: every non-secret value, and for secrets only { set: true|false }.
  function publicView() {
    const out = {};
    for (const [name, fields] of Object.entries(SCHEMA)) {
      out[name] = {};
      for (const [field, spec] of Object.entries(fields)) {
        out[name][field] = spec.kind === 'secret' ? { set: Boolean(values[name]?.[field]) } : liveValue(name, field);
      }
    }
    // The Settings page edits the live configuration, whatever the mode; ready and issuer describe live too.
    const liveReady = (card) => (REQUIRED[card] || []).every(([sec, f]) => Boolean(liveValue(sec, f)));
    return { settings: out, mode: mode(), issuer: liveIssuer(), ready: Object.fromEntries(Object.keys(REQUIRED).map((card) => [card, liveReady(card)])) };
  }

  // patch: { section: { field: string | null } }. null clears a field. For a secret, '' or an omitted field keeps
  // the stored value (the page never has it to send back). Validates everything before writing anything.
  function update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError(null, 'Settings must be an object');
    const next = structuredClone(values);
    for (const [sectionName, fields] of Object.entries(patch)) {
      const spec = Object.hasOwn(SCHEMA, sectionName) ? SCHEMA[sectionName] : null;
      if (!spec) throw new SettingsError(sectionName, `Unknown section ${sectionName}`);
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new SettingsError(sectionName, `${sectionName} must be an object`);
      for (const [name, raw] of Object.entries(fields)) {
        const fieldSpec = Object.hasOwn(spec, name) ? spec[name] : null;
        if (!fieldSpec) throw new SettingsError(`${sectionName}.${name}`, `Unknown field ${sectionName}.${name}`);
        if (raw === null) { if (next[sectionName]) delete next[sectionName][name]; continue; }
        if (raw === '' && fieldSpec.kind === 'secret') continue;
        if (raw === '') { if (next[sectionName]) delete next[sectionName][name]; continue; }
        (next[sectionName] ||= {})[name] = validate(fieldSpec.kind, raw, `${sectionName}.${name}`);
      }
    }
    writePrivate(file, { version: 1, values: next, ...(storedMode ? { mode: storedMode } : {}) });
    values = next;
    return publicView();
  }

  function setMode(next) {
    if (!MODES.includes(next)) throw new SettingsError('mode', `mode must be one of ${MODES.join(', ')}`);
    writePrivate(file, { version: 1, values, mode: next });
    storedMode = next;
    return mode();
  }

  // The PingOne issuer and the base of its auth host for this environment, or '' before an environment is set.
  const liveBase = () => {
    const env = liveValue('p1', 'environmentId');
    return env ? `https://auth.pingone.${liveValue('p1', 'region') || 'com'}/${env}` : '';
  };
  const liveIssuer = () => (liveBase() ? `${liveBase()}/as` : '');
  const authBase = () => (mode() === 'mock' ? `${MOCK_ORIGIN}/${MOCK_ENV_ID}` : liveBase());
  const issuer = () => (authBase() ? `${authBase()}/as` : '');

  return { file, value, liveValue, section, ready, missing, publicView, update, setMode, mode, reload: load, authBase, issuer, liveIssuer };
}
