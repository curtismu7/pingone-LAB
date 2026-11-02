#!/usr/bin/env node
// smoke: drives the real UI in a browser (Playwright) through all 11 flow cards in Mock, the Playground's Tokens tab
// and the spec notes, and fails on any request that leaves the lab's own origin. Starts the lab itself the way a plain
// `npm start` does (no settings, ALLOW_MOCK_SIGNIN unset) unless SMOKE_URL names a lab that is already running (for
// example the Docker one). Needs `npm run build` first, and Chromium (`npx playwright install chromium`).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARDS = ['signin', 'pkce', 'par', 'jar', 'clientCredentials', 'lifecycle', 'userinfo', 'device', 'ciba', 'tokenExchange', 'piflow'];
const failures = [];
const note = (ok, name, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failures.push(name); };

async function startLab() {
  if (process.env.SMOKE_URL) return { base: process.env.SMOKE_URL.replace(/\/$/, ''), stop: () => {} };
  const port = Number(process.env.SMOKE_PORT || 5546);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1lab-smoke-'));
  const env = { ...process.env, PORT: String(port), P1LAB_SETTINGS_FILE: path.join(dir, 'p1.json'), P1LAB_SHARED_FILE: path.join(dir, 'none.json') };
  delete env.ALLOW_MOCK_SIGNIN;
  delete env.LAB_BIND;
  const child = spawn(process.execPath, [path.join(root, 'server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 300 && !out.includes('PingOne Lab on'); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (!out.includes('PingOne Lab on')) { child.kill(); throw new Error('the lab did not start'); }
  return { base: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

const lab = await startLab();
const browser = await chromium.launch();
const offOrigin = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Anything that is not the lab's own origin is refused and counted.
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(lab.base) || url.startsWith('data:')) return route.continue();
    offOrigin.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => note(false, 'page error', e.message));
  const password = (await (await fetch(`${lab.base}/api/config`)).json()).mockSignin?.password;
  note(Boolean(password), 'mock sign-in is allowed on a plain start (no ALLOW_MOCK_SIGNIN)');

  const signInIfAsked = async () => {
    const dialog = page.getByRole('dialog', { name: 'Sign in' });
    for (let i = 0; i < 60; i += 1) {
      if (await dialog.isVisible().catch(() => false)) {
        await dialog.getByLabel('Password').fill(password);
        await dialog.getByRole('button', { name: 'Sign in' }).click();
        return true;
      }
      if (!(await page.getByRole('button', { name: /Running/ }).isVisible().catch(() => false)) && i > 4) return false;
      await page.waitForTimeout(250);
    }
    return false;
  };

  await page.goto(`${lab.base}/#/`);
  // The banner says Live until the page has read the lab's config, so wait for it.
  note(await page.locator('[data-testid="banner"][data-state="mock"]').waitFor({ timeout: 15000 }).then(() => true, () => false), 'starts in Mock');

  for (const id of CARDS) {
    await page.goto(`${lab.base}/#/run/${id}`);
    await page.getByRole('article').waitFor();
    note(await page.getByRole('complementary', { name: 'About this flow' }).isVisible(), `${id}: spec note shown`);
    if (id === 'ciba') await page.getByLabel('User (login_hint)').fill('alice');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await signInIfAsked();
    // Done when Run is back and a Proof panel with at least one point is on the page (device and CIBA poll to approval).
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor({ timeout: 60000 });
    const proof = page.getByRole('region', { name: 'Proof' });
    await proof.waitFor({ timeout: 15000 });
    const bad = await page.locator('.step-err, .pt-error, .chip-error').count();
    const points = await proof.locator('.pt-accepted, .pt-expected').count();
    note(bad === 0 && points > 0, `${id}: ran in Mock`, `${points} accepted point(s), ${bad} error(s)`);
  }

  // The Playground: spec note under the title, and the Tokens tab shows the tokens of the last settled step.
  await page.goto(`${lab.base}/#/playground`);
  await page.getByRole('navigation', { name: 'Flows' }).getByRole('button', { name: /Client credentials/ }).click();
  note(await page.getByRole('complementary', { name: 'About this flow' }).isVisible(), 'playground: spec note shown');
  await page.getByRole('button', { name: 'Run all' }).click();
  await page.getByRole('tab', { name: 'Tokens' }).click();
  const tokens = page.getByRole('tabpanel', { name: 'Tokens' });
  note(await tokens.getByRole('heading', { name: 'Access token' }).waitFor({ timeout: 15000 }).then(() => true, () => false), 'playground: Tokens tab shows the access token');
  note((await page.locator('main').textContent()).includes('calls the in-lab mock PingOne'), 'playground: copy names the mock');

  note(offOrigin.length === 0, 'no request left the lab origin', offOrigin.length ? offOrigin.slice(0, 3).join(', ') : '');
} finally {
  await browser.close();
  lab.stop();
}
if (failures.length) { console.log(`${failures.length} check(s) failed`); process.exit(1); }
console.log('smoke: all checks passed');
