import { newTraceId } from './trace.js';
import { ADVERTISED, list, grant } from './advertised.js';

// The cards: what each one is, whether its settings are complete, and whether the configured PingOne advertises it.
// Only what PingOne can do is here (no DPoP, RAR, DCR or ID-JAG: PingOne's discovery does not advertise them).

export const CARDS = [
  { id: 'signin', title: 'Sign in (pi.flow)', kind: 'flow' },
  { id: 'pkce', title: 'PKCE', kind: 'flow' },
  { id: 'par', title: 'PAR', kind: 'flow' },
  { id: 'jar', title: 'Signed request object (JAR)', kind: 'flow' },
  { id: 'clientCredentials', title: 'Client credentials', kind: 'flow' },
  { id: 'lifecycle', title: 'Token lifecycle: refresh, introspect, revoke', kind: 'flow' },
  { id: 'userinfo', title: 'Userinfo', kind: 'flow' },
  { id: 'device', title: 'Device authorization (RFC 8628)', kind: 'flow' },
  { id: 'ciba', title: 'CIBA (start and poll)', kind: 'flow' },
  { id: 'tokenExchange', title: 'Token exchange (RFC 8693)', kind: 'flow' },
  { id: 'playground', title: 'PingOne Protocol Playground', kind: 'playground' },
  { id: 'discovery', title: 'PingOne discovery check', kind: 'check' },
];

// cached: the last discovery metadata, or null before PingOne was read. advertised is null until then.
export function cardList(settings, cached = null) {
  return CARDS.map((card) => {
    if (card.kind === 'playground') return { ...card, ready: settings.ready('discovery'), missing: settings.missing('discovery') };
    const check = ADVERTISED[card.id];
    return {
      ...card, ready: settings.ready(card.id), missing: settings.missing(card.id),
      ...(check ? { advertised: cached ? Boolean(check(cached.raw, cached)) : null } : {}),
    };
  });
}

// What PingOne says it can do, read from its discovery document. Includes what it does NOT advertise, so the page
// can say plainly why there is no DPoP, RAR or DCR card.
export async function discoveryCheck(p1) {
  const traceId = newTraceId();
  const { metadata, step } = await p1.discover({ traceId, fresh: true });
  const doc = metadata.raw;
  const advertised = (id) => Boolean(ADVERTISED[id](doc, metadata));
  const features = [
    { id: 'piflow', label: 'pi.flow (response_mode)', supported: advertised('piflow') },
    { id: 'pkce', label: 'PKCE S256', supported: advertised('pkce') },
    { id: 'par', label: 'Pushed authorization requests', supported: Boolean(metadata.parEndpoint), required: doc.require_pushed_authorization_requests === true },
    { id: 'jar', label: 'Request objects (request parameter, HS256)', supported: advertised('jar'), algs: list(doc, 'request_object_signing_alg_values_supported') },
    { id: 'requestUri', label: 'request_uri parameter (outside PAR)', supported: doc.request_uri_parameter_supported === true },
    { id: 'clientCredentials', label: 'Client credentials', supported: advertised('clientCredentials') },
    { id: 'refresh', label: 'Refresh tokens', supported: grant('refresh_token')(doc) },
    { id: 'introspection', label: 'Introspection', supported: Boolean(metadata.introspectionEndpoint) },
    { id: 'revocation', label: 'Revocation', supported: Boolean(metadata.revocationEndpoint) },
    { id: 'userinfo', label: 'Userinfo', supported: advertised('userinfo') },
    { id: 'device', label: 'Device authorization', supported: advertised('device') },
    { id: 'ciba', label: 'CIBA (poll)', supported: advertised('ciba'), modes: list(doc, 'backchannel_token_delivery_modes_supported') },
    { id: 'tokenExchange', label: 'Token exchange', supported: advertised('tokenExchange') },
    { id: 'dpop', label: 'DPoP', supported: list(doc, 'dpop_signing_alg_values_supported').length > 0 },
    { id: 'rar', label: 'Rich authorization requests', supported: list(doc, 'authorization_details_types_supported').length > 0 },
    { id: 'dcr', label: 'Dynamic client registration', supported: Boolean(doc.registration_endpoint) },
  ];
  return {
    issuer: metadata.issuer,
    endpoints: {
      authorization: metadata.authorizationEndpoint, token: metadata.tokenEndpoint, jwks: metadata.jwksUri,
      par: metadata.parEndpoint || null, backchannel: metadata.backchannelEndpoint || null, device: metadata.deviceEndpoint || null,
      userinfo: metadata.userinfoEndpoint || null, introspection: metadata.introspectionEndpoint || null, revocation: metadata.revocationEndpoint || null,
    },
    features,
    trace: step ? [step] : [],
  };
}
