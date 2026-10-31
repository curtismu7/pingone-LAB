#!/usr/bin/env node
// provision-p1.mjs: create the lab's own PingOne applications (p1Lab-*) with the grants each card needs, and save
// their ids and secrets into the lab's settings file. DRY RUN BY DEFAULT: without --apply it prints the plan and
// calls nothing. With --apply it writes to a REAL PingOne environment, which is owner-only (owner approval each time).
// It never prints a secret. It never changes or deletes an application it did not name p1Lab-*.
//
// UNVERIFIED until an owner run against a real environment: the Management API body shapes below (grant type names
// such as TOKEN_EXCHANGE, CIBA and DEVICE_CODE, and which application type each grant needs) follow PingOne's
// published application model; a refused POST prints PingOne's message so the owner can adjust.
//
//   The worker comes from the owner's ~/.config/demo-kit/provisioning.json (workerClientId and workerClientSecret of a
//   Worker app with Environment Admin or Application Owner roles; environmentId and region are used when the lab has
//   none); P1LAB_PROVISIONING_FILE overrides the path. Only this owner-run script reads it; the lab server never does.
//   node scripts/provision-p1.mjs            # dry run: prints what it would create
//   node scripts/provision-p1.mjs --apply    # owner only
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createSettings } from '../server/src/settings.js';

const DEFAULT_PROVISIONING_FILE = path.join(os.homedir(), '.config', 'demo-kit', 'provisioning.json');

// role -> the settings it fills and the application it needs.
export const ROLES = {
  signin: { settings: 'signin', type: 'WEB_APP', grantTypes: ['AUTHORIZATION_CODE', 'REFRESH_TOKEN'], auth: 'CLIENT_SECRET_BASIC' },
  pkce: { settings: 'pkce', type: 'NATIVE_APP', grantTypes: ['AUTHORIZATION_CODE'], auth: 'NONE', pkce: 'S256_REQUIRED' },
  par: { settings: 'par', type: 'WEB_APP', grantTypes: ['AUTHORIZATION_CODE'], auth: 'CLIENT_SECRET_BASIC', par: true },
  jar: { settings: 'jar', type: 'WEB_APP', grantTypes: ['AUTHORIZATION_CODE'], auth: 'CLIENT_SECRET_BASIC', requestObject: true },
  clientCredentials: { settings: 'clientCredentials', type: 'WORKER', grantTypes: ['CLIENT_CREDENTIALS'], auth: 'CLIENT_SECRET_BASIC', noRedirect: true },
  device: { settings: 'device', type: 'CUSTOM_APP', grantTypes: ['DEVICE_CODE', 'REFRESH_TOKEN'], auth: 'NONE', noRedirect: true },
  ciba: { settings: 'ciba', type: 'WEB_APP', grantTypes: ['CIBA'], auth: 'CLIENT_SECRET_BASIC', noRedirect: true },
  tokenExchange: { settings: 'tokenExchange', fields: ['exchangeClientId', 'exchangeClientSecret'], type: 'WEB_APP', grantTypes: ['TOKEN_EXCHANGE'], auth: 'CLIENT_SECRET_BASIC', noRedirect: true },
  actor: { settings: 'tokenExchange', fields: ['actorClientId', 'actorClientSecret'], type: 'WORKER', grantTypes: ['CLIENT_CREDENTIALS'], auth: 'CLIENT_SECRET_BASIC', noRedirect: true },
};

const PREFIX = /^[A-Za-z][A-Za-z0-9]{1,20}$/;
// Applications that sign a person in get the OpenID Connect scopes, so ID tokens and userinfo carry the user's
// claims (the environment maps them on the OpenID Connect resource). Without this grant PingOne returns only sub.
export const OIDC_SCOPES = ['openid', 'profile', 'email', 'address', 'phone'];
const SIGNS_IN = new Set(['signin', 'pkce', 'par', 'jar', 'ciba', 'device']);

// The applications the lab needs, as Management API bodies. Pure: no network.
export function plan({ prefix = 'p1Lab', redirectUri }) {
  if (!PREFIX.test(prefix)) throw new Error('The prefix must be 2 to 21 letters or digits');
  return Object.entries(ROLES).map(([role, r]) => ({
    role,
    name: `${prefix}-${role}`,
    settings: r.settings,
    fields: r.fields || ['clientId', 'clientSecret'],
    oidcScopes: SIGNS_IN.has(role) ? OIDC_SCOPES : [],
    body: {
      name: `${prefix}-${role}`,
      description: 'PingOne Lab demo application (created by provision-p1.mjs)',
      enabled: true,
      type: r.type,
      protocol: 'OPENID_CONNECT',
      grantTypes: r.grantTypes,
      ...(r.grantTypes.includes('AUTHORIZATION_CODE') ? { responseTypes: ['CODE'], pkceEnforcement: r.pkce || 'OPTIONAL' } : {}),
      ...(r.noRedirect ? {} : { redirectUris: [redirectUri] }),
      tokenEndpointAuthMethod: r.auth,
      ...(r.par ? { parRequirement: 'OPTIONAL' } : {}),
      ...(r.requestObject ? { requestObjectSigningAlgorithm: 'HS256' } : {}),
    },
  }));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const log = (m) => console.log(`[provision-p1] ${m}`);
  const settings = createSettings({});
  const steps = plan({ prefix: process.env.P1LAB_APP_PREFIX || 'p1Lab', redirectUri: settings.value('p1', 'redirectUri') });
  if (!apply) {
    log('dry run: nothing is called. With --apply (owner only) it would create:');
    for (const s of steps) log(`  ${s.name}: ${s.body.type}, grants ${s.body.grantTypes.join(' ')}${s.oidcScopes.length ? `, scopes ${s.oidcScopes.join(' ')}` : ''} -> settings ${s.settings}.${s.fields[0]}`);
    log('Afterwards, by hand in the PingOne console: assign a resource scope to p1Lab-clientCredentials, a token-exchange');
    log('resource and act mapping to p1Lab-tokenExchange, a CIBA authenticator to p1Lab-ciba, and a sign-on policy to all.');
    return;
  }
  const provisioningFile = process.env.P1LAB_PROVISIONING_FILE || DEFAULT_PROVISIONING_FILE;
  let shared;
  try { shared = JSON.parse(fs.readFileSync(provisioningFile, 'utf8')); } catch { throw new Error(`Cannot read ${provisioningFile}`); }
  const env = settings.value('p1', 'environmentId') || shared.environmentId;
  const tld = settings.value('p1', 'region') || shared.region || 'com';
  if (!env || !shared.workerClientId || !shared.workerClientSecret) throw new Error('The provisioning file needs environmentId, workerClientId and workerClientSecret of a worker');
  const basic = Buffer.from(`${encodeURIComponent(shared.workerClientId)}:${encodeURIComponent(shared.workerClientSecret)}`).toString('base64');
  const tokenRes = await fetch(`https://auth.pingone.${tld}/${env}/as/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!tokenRes.ok) throw new Error(`The worker token was refused (HTTP ${tokenRes.status})`);
  const { access_token: token } = await tokenRes.json();
  const api = `https://api.pingone.${tld}/v1/environments/${env}`;
  const call = async (method, resource, body) => {
    const res = await fetch(`${api}/${resource}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${resource} -> HTTP ${res.status}: ${String(data?.message || data?.details?.[0]?.message || '').slice(0, 200)}`);
    return data;
  };
  const existing = (await call('GET', 'applications'))?._embedded?.applications || [];
  const oidc = ((await call('GET', 'resources'))?._embedded?.resources || []).find((r) => r.type === 'OPENID_CONNECT');
  const oidcScopeIds = oidc ? ((await call('GET', `resources/${oidc.id}/scopes`))?._embedded?.scopes || []).filter((s) => OIDC_SCOPES.includes(s.name)).map((s) => ({ id: s.id })) : [];
  for (const s of steps) {
    const found = existing.find((a) => a.name === s.name);
    const app = found || await call('POST', 'applications', s.body);
    if (s.oidcScopes.length && oidc) {
      const grants = (await call('GET', `applications/${app.id}/grants`))?._embedded?.grants || [];
      if (!grants.some((g) => g.resource?.id === oidc.id)) await call('POST', `applications/${app.id}/grants`, { resource: { id: oidc.id }, scopes: oidcScopeIds });
    }
    const secret = s.body.tokenEndpointAuthMethod === 'NONE' ? null : (await call('GET', `applications/${app.id}/secret`))?.secret;
    // Saved after each application, so a later failure keeps what was already created.
    settings.update({ [s.settings]: { [s.fields[0]]: app.id, ...(secret ? { [s.fields[1]]: secret } : {}) } });
    log(`${s.name}: ${found ? 'already there' : 'created'}, settings ${s.settings} saved${secret ? ' (secret stored, not shown)' : ''}`);
  }
  if (!settings.value('p1', 'environmentId')) settings.update({ p1: { environmentId: env } });
  log('done; restart the lab so it reads the new settings');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[provision-p1] stopped: ${error.message}`); process.exit(1); });
}
