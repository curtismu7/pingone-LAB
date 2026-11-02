# pingone-lab

Tier: Demo. The PingFederate Lab's twin for PingOne: a card per thing PingOne can actually do (what its discovery
document advertises), plus a Protocol Playground, run against the lab's mock PingOne (Mock) or a real PingOne environment (Live). Ping dark
blue page background so it is never confused with the PingFederate Lab. Rules: ~/Development/STANDALONE-RULES-FOR-AGENTS.md
and ~/Development/STANDALONE-CSS-STANDARD.md (use the standalone-demo skill). Ports 5500-5549 (default 5500).

## Mock and live

- Mode is `mode` in the settings file (`PUT /api/mode`); unset = live when an environment is configured, else mock.
  Mock: `server/src/mockp1.js` (host `auth.pingone-mock.invalid`) answers through the outbound door; the real fetch
  sits behind `server/src/netguard.js` (refuses everything in mock mode; self-test at startup). The tests' fake
  (`server/test/fakep1.js`) is the same mock placed on PingOne's real host name.
- Live: outbound ONLY to the configured environment (`https://auth.pingone.<region>/<environment id>/...`) through
  `server/src/outbound.js`; no other module but the netguard may call fetch.
- Mock sign-in needs `ALLOW_MOCK_SIGNIN=1` (plain `npm start` sets it itself on a loopback bind with no PingOne environment: `hostRunMockSignin` in `server/src/app.js`; `=0` turns it off); refused behind a proxy or on a non-loopback bind (`LAB_IN_CONTAINER=1`
  marks the Docker case and only counts inside a real container). `NODE_ENV=production` is NOT a guard (the image sets it). Demo user `alice` / `correct-horse-battery` exists only in the mock.

## Look

- `web/src/standalone-ui.css` is vendored byte-identical (never edit it; `scripts/check-ui-standard.sh`). `app.css` uses
  its tokens: no colour literals at all (the page background is the shared `--bg-lab` token set from `--box-dark`/`--box-blue`), no prefers-color-scheme, no
  !important, no italics, breakpoints 600/900 only. Check: `~/Development/AI-DEMO-Standalone/scripts/check-css.sh ~/Development/pingone-lab`.

## Run and test

- Docker, mock with no setup: `docker compose up --build -d` -> http://127.0.0.1:5500. Live + https: `docker-compose.live.yml` (the local `.env` sets `COMPOSE_FILE` to both files; values for the cert and `LAB_ALLOWED_HOSTS` in the same `.env`) -> https://127.0.0.1:5500.
- `npm install`, `npm run build`, `npm start` (127.0.0.1:5500), `npm test` (runs server and web both: `node --test test/*.test.js`, a glob, never a directory; vitest), `npm run smoke` (Playwright: all 11 flows in Mock; needs `npx playwright install chromium`).
- Node 26 only: `node --test test/*.test.js` (from `server/`).

## Rules that bite

- Only what PingOne advertises: every card is gated on discovery (`server/src/advertised.js`) at runtime and refused
  with `not_advertised` otherwise. No DPoP, RAR, DCR or ID-JAG card: PingOne does not advertise them.
- PingOne pi.flow differs from PingFederate: steps POST `<env>/flows/{id}` (`usernamePassword.check`, and
  `user.lookup` first at SIGN_ON_REQUIRED), bad password = `INVALID_CREDENTIALS`, and the code comes from
  `GET <env>/as/resume?flowId=` (JSON or a Location the lab reads and never follows). Replay the ST cookie jar.
- The web UI only calls the lab's own `/api` (CSP `default-src 'self'`); never navigate to PingOne. The one
  exception is a link: the device card shows PingOne's verification address (on this environment's host only).
- Settings: `~/.config/demo-kit/pingone-lab/pingone-lab.json` (mode 600; `P1LAB_SETTINGS_FILE` for tests); the
  environment id and region fall back to `PINGONE_ENVIRONMENT_ID` and `PINGONE_REGION` in the shared
  `~/Development/.env` (read only, only those two keys; `STANDALONE_ENV` or `P1LAB_SHARED_FILE` for tests). The old
  `pingone.json` is no longer read. Worker/admin credentials live only in `~/.config/demo-kit/provisioning.json`,
  read by the owner-run `scripts/provision-p1.mjs` alone. Secrets are write-only. Agents never read the real files.
- Workspace (rule 13): `X-Lab-Workspace` (default `default`, `^[a-z0-9][a-z0-9-]{0,31}$`) scopes sessions, runs and
  traces; one cookie per workspace. `POST /api/reset` and `npm run reset` clear one workspace only.
- `npm run doctor` (read-only, exit 1 on failure) and `npm run reset` (`LAB_WORKSPACE`, default `default`).
- Every PingOne call is a trace step: secrets redacted (codes, verifiers, client secrets, refresh tokens, device
  codes, auth_req_id, passwords, cookies, flow ids), tokens and request objects masked + claims (a mock-issued token is shown whole in mock mode only: rule 4 exception), W3C traceparent.
- `scripts/provision-p1.mjs` is a dry run by default; `--apply` writes to a real PingOne and is owner-only.
- Loopback bind, Host check, same-origin JSON-only writes, https + Secure cookie when `LAB_TLS_CERT`/`LAB_TLS_KEY` are set.
- No identifiers from other projects; history scan must print 0. EC keys via createECDH, never generateKeyPairSync('ec').
- Agents never call a real PingOne (the public discovery document is the only exception); the owner does live runs.
  Agents test in mock mode.
