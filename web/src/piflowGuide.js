// What the pi.flow card explains, for PingOne. Facts come from this lab's live runs against PingOne (2026-10-30:
// the fields of the first answer, the 15-minute expiry) and from AI-DEMO2's PingOne pi.flow driver
// (demo_api_server/services/piFlowDriver.js) for the statuses this lab does not drive itself.
export const PIFLOW_GUIDE = {
  idp: 'PingOne',
  otherIdp: 'PingFederate',
  idea: [
    'A normal sign-in sends the browser to PingOne\'s own login page and back. With response_mode=pi.flow, the same authorization request gets the sign-in back as JSON instead: a flow with a status that says what PingOne needs next, and links for the actions it will accept.',
    'The app draws its own form, posts what the person typed to the flow, and repeats until PingOne says COMPLETED. PingOne still runs the sign-in: its sign-on policy picks the steps, it checks the password, and it decides on MFA. The app only renders and relays.',
  ],
  steps: [
    { title: 'Open the flow', detail: 'The authorization request (client, redirect URI, scope, PKCE challenge) with response_mode=pi.flow. PingOne answers 200 with the flow JSON, not a login page.', call: 'GET /as/authorize?...&response_mode=pi.flow', onThisCard: true },
    { title: 'Read status', detail: 'status names the form to draw. The flow can be read again at any time; it lives on PingOne, not in the app.', call: 'GET /flows/{flow id}', onThisCard: true },
    { title: 'Post the next action', detail: 'Pick an action from _links and post it with that action\'s content type, for example the username and password.', call: 'POST /flows/{flow id}  Content-Type: application/vnd.pingidentity.usernamePassword.check+json' },
    { title: 'Repeat until COMPLETED', detail: 'Each answer is a new status. An identifier-first policy asks for the username first (user.lookup), then the password; MFA statuses can follow.' },
    { title: 'Get the code', detail: 'A COMPLETED flow does not carry the code. The app calls resumeUrl and reads the authorization code from the JSON or from the redirect it does not follow.', call: 'GET /as/resume?flowId={flow id}' },
    { title: 'Redeem it', detail: 'The code goes to the token endpoint with the PKCE verifier, as in any authorization-code flow. The ID token says who signed in.', call: 'POST /as/token' },
  ],
  stepsNote: 'This card does steps 1 and 2 and sends no password. The Sign in, PKCE, PAR and JAR cards run all six; their trace shows each one.',
  differences: [
    { topic: 'Where the code comes from', here: 'a separate call to resumeUrl after COMPLETED.', other: 'inside the COMPLETED answer, as authorizeResponse' },
    { topic: 'Password action', here: 'usernamePassword.check, posted to /flows/{id}.', other: 'checkUsernamePassword, posted to /pf-ws/authn/flows/{id} with an X-XSRF-Header' },
    { topic: 'Identifier-first', here: 'a policy can open at SIGN_ON_REQUIRED, which needs user.lookup before the password.', other: 'opens straight at USERNAME_PASSWORD_REQUIRED' },
    { topic: 'Wrong password', here: '400 with details[].code INVALID_CREDENTIALS; the flow keeps waiting.', other: 'CREDENTIAL_VALIDATION_FAILED' },
  ],
  fields: [
    { key: 'id', meaning: 'The flow id. Whoever holds it can continue this sign-in, so the lab masks it everywhere, including inside links.' },
    { key: 'status', meaning: 'What PingOne needs next. The app picks the form to draw from this value alone (see the table below).' },
    { key: '_links', meaning: 'The actions PingOne accepts now, each with the URL to post to. An action that is not listed is refused.' },
    { key: '_embedded', meaning: 'Context for drawing the form: here the application\'s name; on later steps, for example, the user or the MFA devices.' },
    { key: 'resumeUrl', meaning: 'Where the app fetches the authorization code once the flow is COMPLETED.' },
    { key: 'environment', meaning: 'The PingOne environment that owns the flow.' },
    { key: 'createdAt', meaning: 'When PingOne opened the flow.' },
    { key: 'expiresAt', meaning: 'When the flow stops working (15 minutes after it opened, in this lab\'s runs). After that, posting to it returns 404 and the sign-in starts again.' },
  ],
  cookieNote: 'Not in the JSON: PingOne also sets a session cookie, and every later call must send it back, or PingOne refuses the step. That cookie ties the flow to the client that opened it. The lab keeps it on its server and shows it as redacted.',
  statuses: [
    { status: 'USERNAME_PASSWORD_REQUIRED', meaning: 'PingOne wants a username and password together.', app: 'Draw both fields; post usernamePassword.check.', lab: 'Drives it (seen live).' },
    { status: 'SIGN_ON_REQUIRED', meaning: 'An identifier-first policy wants the username first.', app: 'Ask for the username; post user.lookup.', lab: 'Drives it.' },
    { status: 'PASSWORD_REQUIRED', meaning: 'The user is known; PingOne wants the password.', app: 'Draw the password field; post usernamePassword.check.', lab: 'Drives it.' },
    { status: 'OTP_REQUIRED', meaning: 'MFA: a one-time code was sent or is due.', app: 'Ask for the code.', lab: 'Stops and shows the status.' },
    { status: 'DEVICE_SELECTION_REQUIRED', meaning: 'MFA: the user has several devices.', app: 'Let the person pick one.', lab: 'Stops and shows the status.' },
    { status: 'ASSERTION_REQUIRED', meaning: 'MFA: a passkey or security key must sign a challenge.', app: 'Call the browser\'s WebAuthn API with the challenge.', lab: 'Stops and shows the status.' },
    { status: 'EXTERNAL_AUTHENTICATION_REQUIRED', meaning: 'The policy hands sign-in to an external identity provider.', app: 'Send the person to the link PingOne gives.', lab: 'Stops and shows the status.' },
    { status: 'COMPLETED', meaning: 'Sign-in is done.', app: 'Call resumeUrl for the code, then redeem it.', lab: 'Drives it.' },
  ],
  statusesNote: 'The first three and COMPLETED are what this lab drives. The four MFA and external statuses are handled by AI-DEMO2\'s PingOne sign-in, not here; give the lab\'s applications a password-only sign-on policy to stay on the driven path.',
  when: {
    good: [
      'First-party apps: your own mobile, desktop or command-line app that needs its own sign-in screen.',
      'Agents and services you run, which have no browser to redirect.',
      'Embedded experiences where leaving the page would break the journey.',
    ],
    avoid: [
      'Third-party apps: with pi.flow the app sees the person\'s password. Use the redirect sign-in with PKCE so only PingOne ever sees it.',
      'Apps that cannot draw every status their sign-on policy can produce (MFA, passkeys, external identity providers).',
    ],
    note: 'Unlike the old password grant (ROPC), pi.flow keeps PingOne in charge of every step: policy, MFA, lockout and risk checks all still apply.',
  },
};
