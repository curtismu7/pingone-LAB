#!/usr/bin/env node
// reset: clears the run state (card runs, results, tokens) of ONE workspace on the running lab through its own
// POST /api/reset, and keeps every saved setting and every sign-in. The workspace is LAB_WORKSPACE (default "default").
// The lab keeps run state in memory only, so with no lab running there is nothing to clear.
import http from 'node:http';
import https from 'node:https';

const port = Number(process.env.PORT || 5500);
const workspace = process.env.LAB_WORKSPACE || 'default';

const post = (lib) => new Promise((resolve, reject) => {
  const req = lib.request({
    host: '127.0.0.1', port, path: '/api/reset', method: 'POST', rejectUnauthorized: false, timeout: 3000,
    headers: { 'content-type': 'application/json', 'x-lab-workspace': workspace },
  }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { reject(new Error('answer is not JSON')); } });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', reject);
  req.end('{}');
});

let answer;
try { answer = await post(http); } catch { try { answer = await post(https); } catch { answer = null; } }
if (!answer) { console.log(`No lab is answering on port ${port}: nothing to reset (run state is in memory only).`); process.exit(0); }
if (answer.status !== 200 || !answer.body?.ok) { console.error(`Reset refused (HTTP ${answer.status}: ${answer.body?.error || 'unknown'})`); process.exit(1); }
console.log(`Workspace "${answer.body.workspace}" reset (${answer.body.sessions} session${answer.body.sessions === 1 ? '' : 's'} cleared). Saved settings and sign-ins kept.`);
