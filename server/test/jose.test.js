import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { s256, pkce, createEcKey, signHs256, signEs256, verifyIdToken, JwtInvalid } from '../src/jose.js';

test('PKCE S256 matches RFC 7636 appendix B', () => {
  assert.equal(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const p = pkce();
  assert.equal(p.challenge, s256(p.verifier));
  assert.equal(p.method, 'S256');
  assert.ok(p.verifier.length >= 43);
});

test('JAR request object: HS256 over header.payload with the client secret, and the secret is not in the JWT', () => {
  const secret = 'client-secret-for-hmac-1';
  const jwt = signHs256({ alg: 'HS256', typ: 'oauth-authz-req+jwt' }, { iss: 'c1', aud: 'https://auth.example/env/as', scope: 'openid' }, secret);
  const [h, p, s] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'HS256');
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).scope, 'openid');
  assert.equal(s, crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url'));
  assert.ok(!jwt.includes(secret) && !Buffer.from(p, 'base64url').toString().includes(secret));
});

test('ID token verification: good token passes; each broken property is refused', () => {
  const key = createEcKey();
  const jwks = { keys: [{ ...key.publicJwk, kid: 'k1', alg: 'ES256', use: 'sig' }] };
  const t = Math.floor(Date.now() / 1000);
  const base = { iss: 'https://auth.example/env/as', aud: 'c1', sub: 'alice', nonce: 'n', exp: t + 60 };
  const make = (claims, header = { alg: 'ES256', kid: 'k1' }, signer = key) => signEs256(header, claims, signer.privateKey);
  const opts = { jwks, issuer: 'https://auth.example/env/as', audience: 'c1', nonce: 'n' };
  assert.equal(verifyIdToken(make(base), opts).sub, 'alice');
  const bad = [
    make({ ...base, iss: 'https://other.example' }),
    make({ ...base, aud: 'c2' }),
    make({ ...base, nonce: 'm' }),
    make({ ...base, exp: t - 3600 }),
    make({ ...base, aud: ['c1', 'c2'] }),
    make(base, { alg: 'ES256', kid: 'k1' }, createEcKey()),
    make(base, { alg: 'none', kid: 'k1' }),
    make(base, { alg: 'HS256', kid: 'k1' }),
    make(base, { alg: 'ES256', kid: 'other' }),
    'not.a.jwt',
    'two.parts',
  ];
  for (const token of bad) assert.throws(() => verifyIdToken(token, opts), JwtInvalid);
});
