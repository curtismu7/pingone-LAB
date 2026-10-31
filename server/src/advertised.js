// What each card needs PingOne's discovery document to advertise. Shared by the PingOne client (which refuses a card
// its PingOne does not advertise, before any other call) and the card list.

export const list = (doc, field) => (Array.isArray(doc?.[field]) ? doc[field].map(String) : []);
export const grant = (name) => (doc) => list(doc, 'grant_types_supported').includes(name);
const piFlow = (doc) => list(doc, 'response_modes_supported').includes('pi.flow');

export const ADVERTISED = {
  signin: piFlow,
  pkce: (doc) => piFlow(doc) && list(doc, 'code_challenge_methods_supported').includes('S256'),
  par: (doc, m) => piFlow(doc) && Boolean(m.parEndpoint),
  jar: (doc) => piFlow(doc) && doc.request_parameter_supported === true && list(doc, 'request_object_signing_alg_values_supported').includes('HS256'),
  clientCredentials: grant('client_credentials'),
  lifecycle: (doc, m) => grant('refresh_token')(doc) && Boolean(m.introspectionEndpoint) && Boolean(m.revocationEndpoint),
  userinfo: (doc, m) => Boolean(m.userinfoEndpoint),
  device: (doc, m) => Boolean(m.deviceEndpoint) && grant('urn:ietf:params:oauth:grant-type:device_code')(doc),
  ciba: (doc, m) => Boolean(m.backchannelEndpoint) && grant('urn:openid:params:grant-type:ciba')(doc) && list(doc, 'backchannel_token_delivery_modes_supported').includes('poll'),
  tokenExchange: grant('urn:ietf:params:oauth:grant-type:token-exchange'),
  piflow: piFlow,
};

