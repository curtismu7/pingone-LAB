// One plain paragraph per card: what the feature is, and why it matters when an AI agent acts for someone.
export const EXPLAIN = {
  signin: 'The person signs in through this app\'s own form. The app asks PingOne for a sign-in flow as JSON (response_mode=pi.flow), posts the username (when the policy is identifier-first) and the password to PingOne\'s flows API, asks PingOne for the authorization code once the flow is complete, and redeems it with PKCE. No redirect to a login page. For agents this matters because native and agent clients need to drive sign-in themselves, and the ID token says exactly who the agent will act for.',
  pkce: 'Proof Key for Code Exchange: the authorization request carries a hash of a secret (S256 code_challenge) and the code is only redeemed with the secret itself (code_verifier). For agents, which are often public clients without a client secret, PKCE is what stops a stolen authorization code from being used.',
  par: 'Pushed authorization requests: the client sends its whole authorization request to PingOne over a back channel and gets a one-time request_uri; the browser-side request carries only that handle. For agents nothing in the request can be read or changed on the way.',
  jar: 'JWT-secured authorization requests (JAR): every authorization parameter travels inside a JWT the client signs (here HS256, keyed with its client secret, which PingOne advertises). PingOne checks the signature before it trusts any parameter. For agents a tampered scope or redirect breaks the signature instead of slipping through.',
  clientCredentials: 'The client credentials grant: an application gets a token for itself, with no user. PingOne grants only the scopes of a resource assigned to the application. For agents this is the agent\'s own identity when it acts on its own behalf, kept apart from tokens that act for a person.',
  lifecycle: 'Refresh, introspect, revoke: the signed-in user\'s refresh token buys new tokens, introspection asks PingOne whether the access token is active, revocation kills the refresh token, and a last refresh with it must be refused. For agents this is how a long-running agent keeps access, and how a person or an admin takes it away.',
  userinfo: 'Userinfo: the access token reads the user\'s claims from PingOne. The lab checks that the answer is for the same subject as the verified ID token. For agents it is how a service learns who the agent acts for, from the token alone.',
  device: 'Device authorization (RFC 8628): PingOne gives the app a short user code and an address; the person signs in there on a phone or laptop while the app polls. This is the one card where the sign-in happens on PingOne\'s own pages, on another device. For agents and devices without a keyboard it is the honest way to get a person\'s consent.',
  ciba: 'Client-initiated backchannel authentication: the app names a user, PingOne asks that user to approve through its own authenticator (the CIBA flow set on the application, such as PingOne MFA), and the app polls until they approve, deny, or the request expires. The lab has no approve button: the person approves wherever PingOne sends the request. For agents this is human-in-the-loop done properly.',
  tokenExchange: 'RFC 8693 token exchange: the signed-in user\'s access token is exchanged for a new token; when an actor application is set, its own token goes in as actor_token and the new token\'s act claim should name it. PingOne builds the claims from the exchange application\'s attribute mappings, so each check is shown pass or fail. For agents this is delegation you can audit.',
  playground: 'Every flow on one page, step by step: execute one step at a time or run them all, and see each request and PingOne\'s answer next to the sequence of calls. It runs the same server steps as the cards.',
};

// A short spec note per flow, shown under the flow's title: the standard it follows (badge and link), what it solves,
// a real-world example, and why it matters when an AI agent acts for someone. `refs` link to the public specs; a
// flow with no public spec (PingOne's own flows API) has none.
const RFC = (n, label = `RFC ${n}`, hash = '') => ({ label, url: `https://www.rfc-editor.org/rfc/rfc${n}${hash}` });
const OIDC_CORE = 'https://openid.net/specs/openid-connect-core-1_0.html';
export const SPEC = {
  signin: {
    refs: [{ label: 'OpenID Connect Core 1.0', url: OIDC_CORE }],
    solves: 'Signs a person in from inside your own app, without sending the browser to a login page: PingOne returns the sign-in as JSON (response_mode=pi.flow) and the app relays each step.',
    example: 'A mobile banking app or a command-line tool draws its own login screen and still ends up with an ID token PingOne verified.',
    agents: 'An agent that runs where no browser can redirect can still learn, from a verified ID token, exactly who it acts for.',
  },
  pkce: {
    refs: [RFC(7636)],
    solves: 'Stops a stolen authorization code from being redeemed: the code is tied to a one-time secret that only the client that started the sign-in knows.',
    example: 'A native app or single-page app has no safe place for a client secret; malware that reads the redirect still cannot trade the code for tokens.',
    agents: 'Agents are usually public clients with no client secret, so PKCE is the baseline protection for the sign-ins they start.',
  },
  par: {
    refs: [RFC(9126)],
    solves: 'Moves the authorization request out of the browser address bar: the client posts it over a back channel and gets a short-lived request_uri to put in the browser request instead.',
    example: 'A payment app pushes the amount and payee in the request, so neither the user nor a browser extension can edit them in the URL.',
    agents: 'What an agent asks for (scopes, details) cannot be read or changed on its way through the person\'s browser.',
  },
  jar: {
    refs: [RFC(9101)],
    solves: 'Puts every authorization parameter inside a JWT the client signs, so PingOne can tell the request came from that client and was not altered.',
    example: 'A link rewritten to ask for broader scopes fails the signature check instead of reaching the consent screen.',
    agents: 'A tampered scope or redirect URI breaks the signature, so an agent\'s request cannot be silently widened.',
  },
  clientCredentials: {
    refs: [RFC(6749, 'RFC 6749 section 4.4', '#section-4.4')],
    solves: 'Gives an application an access token for itself, using its own credentials, with no user involved.',
    example: 'A nightly job calls an internal orders API on behalf of the company, not of any one employee.',
    agents: 'This is the agent\'s own identity for work it does on its own account, kept apart from tokens that act for a person.',
  },
  lifecycle: {
    refs: [RFC(6749, 'RFC 6749 section 6', '#section-6'), RFC(7662), RFC(7009)],
    solves: 'Keeps access tokens short-lived but renewable (refresh), lets an API ask whether a token is still good (introspect), and lets access be cut off on demand (revoke).',
    example: 'A person chooses "sign out everywhere": revoking the refresh token means the app can no longer get new access tokens.',
    agents: 'A long-running agent can renew its access without bothering the person, and the person or an admin can end that access at any time.',
  },
  userinfo: {
    refs: [{ label: 'OpenID Connect Core 1.0 section 5.3', url: `${OIDC_CORE}#UserInfo` }],
    solves: 'Reads claims about the signed-in user (name, email and so on) from the identity provider, using the access token.',
    example: 'A web app shows the person\'s name and email after sign-in without stuffing every claim into the ID token.',
    agents: 'A tool or API handed only an access token can find out who the agent is acting for, from the token alone.',
  },
  device: {
    refs: [RFC(8628)],
    solves: 'Lets a device with no keyboard or browser get a person\'s approval: it shows a short code, the person enters it on a phone or laptop, and the device polls for the result.',
    example: 'A smart TV app shows a code; you type it on your phone to sign in.',
    agents: 'A headless agent or command-line tool can get a person\'s consent without ever seeing their password.',
  },
  ciba: {
    refs: [{ label: 'OpenID CIBA Core 1.0', url: 'https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html' }],
    solves: 'The app names a user and the identity provider asks that user to approve on their own device, over a separate channel, while the app polls for the answer.',
    example: 'A call-centre agent starts a refund and the customer approves it with a push notification in their banking app.',
    agents: 'Human-in-the-loop approval: an agent can pause before a risky action until the right person says yes.',
  },
  tokenExchange: {
    refs: [RFC(8693)],
    solves: 'Trades one token for another with a different audience, scope or identity, and can record who is acting on whose behalf (the act claim).',
    example: 'A gateway swaps the user\'s token for one that is valid only at the orders service.',
    agents: 'Delegation you can audit: the new token can name the agent that is working for the user.',
  },
  discovery: {
    refs: [RFC(8414), { label: 'OpenID Connect Discovery 1.0', url: 'https://openid.net/specs/openid-connect-discovery-1_0.html' }],
    solves: 'The identity provider publishes a JSON document that lists its endpoints and the features it supports.',
    example: 'A client library configures itself from nothing but the issuer address.',
    agents: 'An agent can check what the provider supports before it tries a flow, instead of failing halfway.',
  },
};
