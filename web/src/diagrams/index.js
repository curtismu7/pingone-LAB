import signin from './p1l-signin.json';
import pkce from './p1l-pkce.json';
import par from './p1l-par.json';
import jar from './p1l-jar.json';
import clientCredentials from './p1l-client-credentials.json';
import lifecycle from './p1l-lifecycle.json';
import userinfo from './p1l-userinfo.json';
import device from './p1l-device.json';
import ciba from './p1l-ciba.json';
import tokenExchange from './p1l-token-exchange.json';
import piflow from './p1l-piflow.json';

// Static diagrams are diagram-studio/1 data, loaded by id. No nodes or edges are built in JSX.
const ALL = [signin, pkce, par, jar, clientCredentials, lifecycle, userinfo, device, ciba, tokenExchange, piflow];
const BY_ID = new Map(ALL.map((diagram) => [diagram.id, diagram]));

export function loadDiagram(id) {
  const diagram = BY_ID.get(id);
  if (!diagram) throw new Error(`Unknown diagram: ${id}`);
  return diagram;
}
export const DIAGRAM_IDS = ALL.map((diagram) => diagram.id);
// The named diagram for each card.
export const CARD_DIAGRAM = { signin: 'p1l-signin', pkce: 'p1l-pkce', par: 'p1l-par', jar: 'p1l-jar', clientCredentials: 'p1l-client-credentials', lifecycle: 'p1l-lifecycle', userinfo: 'p1l-userinfo', device: 'p1l-device', ciba: 'p1l-ciba', tokenExchange: 'p1l-token-exchange', piflow: 'p1l-piflow' };
