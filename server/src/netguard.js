// The network guard. Mock mode must never reach the network: every real fetch the lab could make passes through
// guard.guarded, which refuses it before a socket opens whenever the lab is in mock mode and counts the attempt. In
// mock mode the outbound door hands calls to the in-process mock instead, so a refusal here means a bug, and the
// tests assert there are none. selfTest() proves the guard itself works; the server runs it at startup.

export class NetguardRefused extends Error {
  constructor(url) {
    super('Mock mode: a real network call was refused');
    this.reason = 'netguard';
    this.url = url;
  }
}

export function createNetguard({ fetchImpl = globalThis.fetch, isMock }) {
  let refused = 0;
  async function guardedFetch(url, init) {
    if (isMock()) { refused += 1; throw new NetguardRefused(String(url)); }
    return fetchImpl(url, init);
  }
  return { guarded: guardedFetch, refusals: () => refused };
}

// A guard in mock mode in front of a fetch that records: the call must be refused and the fetch never called.
export async function selfTest({ makeGuard = createNetguard } = {}) {
  let reached = 0;
  const guard = makeGuard({ fetchImpl: async () => { reached += 1; return new Response(null); }, isMock: () => true });
  let refusedOk = false;
  try { await guard.guarded('https://auth.pingone.com/', {}); } catch (error) { refusedOk = error instanceof NetguardRefused; }
  return { ok: refusedOk && reached === 0 && guard.refusals() === 1 };
}
