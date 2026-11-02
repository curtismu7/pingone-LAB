# PingOne LAB

Every PingOne feature for apps and AI agents on one shelf, run against a simulated PingOne (Mock) or your own PingOne environment (Live).

## Tier, repo and catalog

Tier: Demo

Repo: https://github.com/ping-sandbox/pingone-LAB

Catalog: A29 (accepted by the owner, 2026-10-31); `content-pack.json` carries it in `demo.catalog`.

The PingFederate LAB's twin for PingOne: one card per thing PingOne can actually do (what its discovery document
advertises), plus a Protocol Playground. Each card shows every request and response, with secrets redacted on the
server. The page background is the Ping dark blue so it is never confused with the PingFederate LAB (see "Look").
Rules: `~/Development/STANDALONE-RULES-FOR-AGENTS.md` and `~/Development/STANDALONE-CSS-STANDARD.md`.

## What is simulated

- **Mock mode:** a simulated PingOne runs inside the lab (`server/src/mockp1.js`, on the `.invalid` host
  `auth.pingone-mock.invalid`). Every card, the sign-in and the Playground work with no settings and no network.
  Everything it issues is labelled mock. It has one demo user, `alice` / `correct-horse-battery`, which exists nowhere
  else.
- **Live mode (owner-run):** the PingOne environment named in Settings. The lab calls only that environment: https,
  the auth host of its region, only paths under `/<environment id>/`, no redirects, 10 s timeout, 256 KB cap.
- Mock cannot show PingOne's real policies, MFA, or what your environment advertises. Features that are UNVERIFIED
  until an owner run are listed below.

## Run from a clone

Prerequisites: Node 26 (Docker only for the Docker form).

```sh
git clone https://github.com/ping-sandbox/pingone-LAB.git
cd pingone-LAB
npm install
npm run build        # builds web/dist, which the server serves
npm start            # http://127.0.0.1:5500 (loopback only)
```

Open http://127.0.0.1:5500. With no setup, the lab starts in **Mock** and every card works: plain `npm start` turns
mock sign-in on by itself (loopback bind, no PingOne environment configured), so sign in with the demo user shown in the
dialog. `npm run dev:web` runs Vite on 127.0.0.1:5501 for development.

## Settings file

The lab starts with no settings. To use Live, set these (names only; the Settings page writes them, secrets are
write-only and `GET /api/settings` says only `{ set: true|false }`):

- **Shared family file `~/Development/.env`** (`STANDALONE_ENV` overrides the path; read only, never written; only
  these two keys are read): `PINGONE_ENVIRONMENT_ID`, `PINGONE_REGION` (`com`, `eu`, `ca` or `asia`).
- **The lab's own file `~/.config/demo-kit/pingone-lab/pingone-lab.json`** (mode 600; `P1LAB_SETTINGS_FILE` overrides):

| Section | Fields |
| --- | --- |
| `p1` | `environmentId`, `region`, `redirectUri` (optional; default `http://127.0.0.1:<PORT>/callback`; never visited under pi.flow) |
| `signin` | `clientId`, `clientSecret`, `scope` (also used by lifecycle, userinfo and as the token-exchange subject) |
| `pkce`, `par`, `jar`, `device`, `ciba` | `clientId`, `clientSecret` (optional for a public client; JAR needs one, it is the HMAC key), `scope` |
| `clientCredentials` | `clientId`, `clientSecret`, `scope` (a resource scope assigned to the application) |
| `tokenExchange` | `exchangeClientId`, `exchangeClientSecret`, `scope`; optional `actorClientId`, `actorClientSecret`, `actorScope`, `audience` |

Admin and worker credentials never belong in this lab. `scripts/provision-p1.mjs` (owner-run; dry run by default)
plans the lab's own `p1Lab-*` applications and, with `--apply`, creates them with a worker read from the owner's
`~/.config/demo-kit/provisioning.json` (`P1LAB_PROVISIONING_FILE` overrides); the lab server never reads that file.
It never prints a secret. Some steps stay manual in the PingOne console (a resource scope for client credentials, the
token-exchange resource and `act` mapping, a CIBA authenticator, a sign-on policy with username and password).

## Ports, and what to do if the port is taken

Ports: PingOne LAB listens on 5500 (set with PORT, default 5500).
Port range for this app: 5500-5549.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:5500 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port:
   PORT=5501 npm start
4. Do not use 8080, 5173, 3000, 4000, 4400, 4510, 4600-4601, 18080, 19080 or 19090.

To remap a port, set `PORT` and the published port to the same number (in Docker: the `ports` entry, `PORT` and the
health-check port in `docker-compose.yml`), because the Host check only accepts the port the lab listens on.
`LAB_ALLOWED_HOSTS` (comma-separated host names that point at this Mac) adds extra names.

## Mock and live modes

The header's **Mock / Live** toggle (on every page, presenter mode included) switches the whole lab, and the banner
says which mode is on. The choice is saved in the settings file (`mode`). With no choice saved, the lab starts in
**Live** when a PingOne environment is configured and in **Mock** otherwise. Switching signs everyone out.

- **Mock:** the outbound door hands every call to the in-process mock instead of the network; the real `fetch`
  sits behind a netguard (`server/src/netguard.js`) that refuses anything in mock mode. The server runs the
  netguard's self-test at startup and refuses to start if it fails; a test runs every card in mock mode with no
  settings file and asserts zero real outbound attempts. `/api/health` says `runtime: offline`.
- **Mock sign-in** (rule 11): needs `ALLOW_MOCK_SIGNIN=1`. Docker sets it in `docker-compose.yml`; plain `npm start`
  sets it for you when the lab binds loopback and no PingOne environment is configured (`ALLOW_MOCK_SIGNIN=0` turns it
  off, and a configured environment or a wider bind leaves it off). It is refused behind a proxy
  (`Forwarded`, `X-Forwarded-*`, `Via`) and on a non-loopback bind. Docker binds 0.0.0.0 inside the container
  (`LAB_IN_CONTAINER=1`, honoured only when the process really is in a container: `/.dockerenv` or a container
  runtime in the cgroup of process 1) while compose publishes 127.0.0.1 only. `NODE_ENV=production` is **not** a
  guard: the Docker image sets it and mock sign-in still works there, by design.
- **Live:** one module (`server/src/outbound.js`) is the only way out; a test refuses every other URL and fails if any
  other module calls `fetch`. The Settings page always edits the live configuration; Mock never changes it.
- **Workspace:** a name in the header (default `default`) keeps one presenter's sign-in, runs and traces apart from
  another's. Every call carries it (`X-Lab-Workspace`); a browser holds one session cookie per workspace.
- **Tokens (rule 4, owner exception 2026-10-31):** in Mock the tokens are fake, so they are shown **whole**, labelled
  mock, next to their decoded header and claims. In Live they are shown **masked** (first 6 and last 4 characters,
  length, kind) with the decoded claims, and a live token never appears whole, whatever its claims say. Secrets
  (codes, refresh tokens, client secrets, cookies) are redacted in both modes.

## Health, doctor and reset

- `GET /api/health` returns `demo-health/1` (`state`, `runtime` `offline` or `live`, `demo`). Public, GET only, no detail.
- `npm run doctor` prints one line per check and exits 1 on failure: Node 26, settings readable, netguard self-test,
  mock discovery, port free or this lab, health route, diagrams. It is read-only, calls no PingOne and never reads your real settings file (name one with `P1LAB_SETTINGS_FILE` to check it).
- `npm run reset` clears the run state (card runs, results, tokens) of one workspace on the running lab and keeps
  saved settings and sign-ins. `LAB_WORKSPACE=<name> npm run reset` names the workspace (default `default`). The
  same is `POST /api/reset` (the Reset button), scoped to the caller's workspace.

## Docker (optional)

Mock mode, no setup (no `.env`, no certificate, no PingOne). One command; the port is published on 127.0.0.1 only:

```sh
docker compose up --build -d   # http://127.0.0.1:5500
```

It runs read-only as a non-root user, keeps its settings in a named volume, and restarts with Docker. Use OrbStack,
not Docker Desktop.

**Live mode and https** need more: `docker-compose.live.yml` adds a certificate (`P1LAB_TLS_CERT_FILE` and
`P1LAB_TLS_KEY_FILE`, which must cover 127.0.0.1, localhost and every `LAB_ALLOWED_HOSTS` name) and mounts your
settings folder `~/.config/demo-kit/pingone-lab/`. Copy `.env.example` to `.env` (not committed), fill it in, and run
`docker compose up --build -d` (the `.env` sets `COMPOSE_FILE` to both files), then open https://127.0.0.1:5500. The
health check works with and without https.

## Tests

```sh
npm test             # server: node --test test/*.test.js; web: vitest
scripts/check-ui-standard.sh   # the vendored shared stylesheet matches the canonical copy (and the hash pinned in scripts/standalone-ui.sha256, which CI checks)
~/Development/AI-DEMO-Standalone/scripts/check-css.sh .   # CSS standard
```

`npm test` runs both workspaces even when one fails. `npm run smoke` drives all 11 flows in Mock through a real browser
(Playwright; run `npx playwright install chromium` once; CI runs it too).

On Node 26 (v26.8.2): server 118/118, web 67/67; smoke 28/28 checks.

## Troubleshooting

1. **A card says "Not advertised".** Your PingOne does not offer that feature; nothing is broken. Settings > discovery
   check lists what it advertises.
2. **"Mock sign-in is off".** With a PingOne environment configured (or `ALLOW_MOCK_SIGNIN=0`), start with
   `ALLOW_MOCK_SIGNIN=1 npm start`. Docker sets it. It is refused behind a proxy.
3. **"Sign-in expired (404)".** A pi.flow lives 15 minutes. Press Run again.
4. **The port is taken.** See "Ports" above.
5. **Everything signed out after a rebuild.** Sessions are in memory only; sign in again.

## Ownership

Owner: the PingOne demo owner (Demo tier, the Ping demo family). Licence: not set yet (the owner decides before the
repo is published). Report problems to the owner; nothing here is a supported Ping product.

---

## Look

The lab vendors the family's shared `standalone-ui.css` byte-identical (`web/src/standalone-ui.css`;
`scripts/check-ui-standard.sh` compares it with the canonical copy, and in CI with a pinned hash) and loads it before `web/src/app.css`, which
holds layout only and uses the shared tokens. Montserrat and IBM Plex Mono are bundled (no web font service), and
the header carries the Ping logo. The theme picker (Auto, Light, Dark) only sets `data-theme`; dark mode is defined
in the shared file.

**The page background (owner, 2026-10-31):** the shared stylesheet gives every app a per-app background token,
`--bg-lab` (default: the normal page colour). This lab sets it in `app.css` to the official Ping dark gradient, built
only from the shared diagram-box tokens (`--box-dark` to `--box-blue`, dark in both themes), so there is no colour
literal in the app's CSS and `check-css.sh` passes. The page content sits on the shared light or dark surfaces; the
header and footer sit on the blue with white text and white control edges.

## Only what PingOne advertises

The card list is the PingOne discovery document's list, checked on 2026-10-30 against a real environment, and every
card is gated on discovery again at runtime (`server/src/advertised.js`): a card your PingOne does not advertise
shows "Not advertised" and its routes answer `409 not_advertised` before any other call.

| Card | Needs PingOne to advertise |
| --- | --- |
| Sign in (pi.flow) | `response_modes_supported` has `pi.flow` |
| PKCE | `pi.flow` and `S256` |
| PAR | `pi.flow` and a PAR endpoint |
| Signed request object (JAR) | `pi.flow`, `request_parameter_supported`, HS256 request objects |
| Client credentials | the `client_credentials` grant |
| Token lifecycle (refresh, introspect, revoke) | the `refresh_token` grant, introspection and revocation endpoints |
| Userinfo | a userinfo endpoint |
| Device authorization (RFC 8628) | a device authorization endpoint and the device_code grant |
| CIBA | a backchannel endpoint, the CIBA grant, `poll` delivery |
| Token exchange (RFC 8693) | the token-exchange grant |
| Flows API: open and read a pi.flow | `pi.flow` |

Not here, because PingOne does not advertise them: DPoP, rich authorization requests (RAR), dynamic client
registration, ID-JAG, the `claims` parameter, `request_uri` outside PAR. The discovery check in Settings lists them
as "not advertised".

**Intentionally not in this lab (owner decision):** DPoP, RAR, ID-JAG, SPIFFE, Transaction Tokens and Resource
Metadata. DPoP and ID-JAG are PingFederate-only; see pingfederate-LAB and id-jag-standalone-LAB.

## How the PingOne flows run

- **pi.flow sign-in** (Sign in, PKCE, PAR, JAR): the authorization request carries `response_mode=pi.flow`; PingOne
  answers with a JSON flow. The lab's own form posts `user.lookup` (when the policy is identifier-first, status
  `SIGN_ON_REQUIRED`) and `usernamePassword.check` to `<env>/flows/{id}`, replaying PingOne's ST cookies. When the
  flow is `COMPLETED`, `GET <env>/as/resume?flowId=` hands back the code, as JSON or as a redirect the lab reads and
  never follows. The code is redeemed with PKCE on the server; the ID token is verified. A wrong password
  (`INVALID_CREDENTIALS`) leaves the flow waiting; a policy that asks for MFA stops the run at that status (this
  lab drives passwords only); an expired flow (404) says to press Run again.
- **JAR**: every authorization parameter goes in a request object signed HS256 with the client secret (PingOne
  advertises HS256); `client_id`, `response_type`, `scope` and `response_mode` are repeated outside.
- **Lifecycle**: refresh, introspect, revoke the refresh token, then a refresh with it, which PingOne must refuse
  (shown as "refused as expected").
- **Device**: the card shows the user code and PingOne's verification link (only when it is on this environment's
  host) and polls. This is the one card where the sign-in happens on PingOne's pages, on another device.
- **CIBA**: PingOne asks the user through the CIBA authenticator set on the application; the lab has no approve
  button and only polls.
- **Token exchange**: the signed-in user's token is the subject; with an actor application set, its own
  client-credentials token is the actor. Checks (sub kept, `act` names the actor, scope, audience) are shown pass or
  fail.

## UNVERIFIED until an owner run against a real PingOne

The owner ran the lab against a real environment on 2026-10-30: discovery, the pi.flow open card (raw flow JSON),
sign-in through pi.flow with the resume step, a wrong password refused as `INVALID_CREDENTIALS`, Userinfo with
profile, email, address and phone claims, and client credentials. The rest follows PingOne's documented API and
the family's full sign-in demo (its working pi.flow driver), and is proven here only against the mock:

- `user.lookup` on an identifier-first policy;
- pi.flow after PAR (`response_mode` in the pushed request and repeated outside) and after JAR;
- whether PingOne's CIBA accepts a username or needs the user id as `login_hint`;
- the device verification address host, and the refresh-token rotation behaviour;
- the Management API bodies in `scripts/provision-p1.mjs` (grant type names such as `TOKEN_EXCHANGE`, `CIBA`, `DEVICE_CODE`).
