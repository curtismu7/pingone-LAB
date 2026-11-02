import { SPEC } from '../content.js';

// The short spec note under a flow's title: standard (badge and link), what it solves, an example, why it matters for agents.
export default function SpecNote({ flowId }) {
  const spec = SPEC[flowId];
  if (!spec) return null;
  return (
    <aside className="spec" aria-label="About this flow" data-testid={`spec-${flowId}`}>
      {spec.refs.length > 0 && (
        <p className="spec__refs">
          {spec.refs.map((r) => <a key={r.url} className="spec__badge" href={r.url} target="_blank" rel="noreferrer noopener">{r.label}</a>)}
        </p>
      )}
      <dl className="spec__list">
        <div><dt>What it solves</dt><dd>{spec.solves}</dd></div>
        <div><dt>Real-world example</dt><dd>{spec.example}</dd></div>
        <div><dt>Why it matters for AI agents</dt><dd>{spec.agents}</dd></div>
      </dl>
    </aside>
  );
}
