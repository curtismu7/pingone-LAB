// The tests' fake PingOne: the lab's own mock (src/mockp1.js), placed on PingOne's real host name so the live-mode
// code paths (region host, discovery checks) are exercised exactly as against a tenant. It is reached only through
// the fetchImpl a test injects; nothing here opens a socket.
import { createMockP1, ENV_ID, USER } from '../src/mockp1.js';

export { ENV_ID, USER };
export const ORIGIN = 'https://auth.pingone.com';
export const BASE = `${ORIGIN}/${ENV_ID}`;
export const ISSUER = `${BASE}/as`;
export const createFakeP1 = (options = {}) => createMockP1({ origin: ORIGIN, ...options });
