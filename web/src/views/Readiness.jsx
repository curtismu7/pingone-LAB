// The readiness badge: ready, or the settings this card still needs, each linking to its field on the Settings page.
// A card the configured PingOne does not advertise says so first: settings cannot fix that.
export default function Readiness({ card }) {
  if (card.advertised === false) return <span className="badge badge-need">Not advertised</span>;
  if (card.ready) return <span className="badge badge-ok">Ready</span>;
  const missing = card.missing || [];
  return (
    <span className="badge badge-need">
      Needs {missing.length ? missing.map((m, i) => (
        <span key={m}>{i ? ', ' : ''}<a href={`#/settings/${m}`}>{m}</a></span>
      )) : <a href="#/settings">setup</a>}
    </span>
  );
}
