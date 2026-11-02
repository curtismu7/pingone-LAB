import { useEffect, useRef, useState } from 'react';
import DiagramView from '../DiagramView.jsx';
import Proof from '../Proof.jsx';
import Steps from './Steps.jsx';
import Credentials from './Credentials.jsx';
import Readiness from './Readiness.jsx';
import PiFlowGuide from './PiFlowGuide.jsx';
import SpecNote from './SpecNote.jsx';
import { useFlowRun } from '../useFlowRun.js';
import { CARD_DIAGRAM } from '../diagrams/index.js';
import { EXPLAIN } from '../content.js';
import { api } from '../api.js';

// Cards that sign a user in through pi.flow and take an optional user (sent as login_hint).
const HINT_CARDS = new Set(['signin', 'pkce', 'par', 'jar']);
// Cards that work on the signed-in user's tokens.
const NEEDS_SIGNIN = new Set(['lifecycle', 'userinfo', 'tokenExchange']);

// One card: run its server steps in order, answer PingOne's credential prompt in the lab's own form, and read the
// proof (sequence, proof points, raw trace).
export default function RunView({ card, story, onChanged, autoStart = false, onAutoStarted, signedInAs = null }) {
  const run = useFlowRun(card.id, { onSettled: onChanged });
  const [loginHint, setLoginHint] = useState('');
  const [bindingMessage, setBindingMessage] = useState('');
  const waitingResult = run.waiting >= 0 ? run.results[run.waiting] : null;
  // CIBA and device: the latest "still pending" answer (user code, who was asked).
  const pending = card.id === 'ciba' || card.id === 'device' ? run.results.map((r) => r?.data).filter((d) => d?.state === 'pending').at(-1) : null;

  // CIBA asks PingOne to get one named user's approval: the typed user, or else whoever is signed in here.
  const cibaApprover = loginHint.trim() || signedInAs || '';
  const notAdvertised = card.advertised === false;
  const needsSignin = NEEDS_SIGNIN.has(card.id) && !signedInAs;
  const start = () => run.runAll({ loginHint, bindingMessage });
  // StrictMode runs effects twice in development; the ref keeps it to one start.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    onAutoStarted?.();
    if (card.ready && !run.busy) start();
  }, [autoStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = async () => { await api.reset(); run.clear(); onChanged?.(); };

  return (
    <article className="run" aria-labelledby="run-title">
      <p className="crumbs"><a href="#/">Shelf</a> / {card.title}</p>
      <header className="run-head">
        <h2 id="run-title">{card.title}</h2>
        <Readiness card={card} />
      </header>
      <SpecNote flowId={card.id} />
      {story && <p className="story">{story}</p>}
      <p className="explain">{EXPLAIN[card.id]}</p>
      {notAdvertised && (
        <p className="pt pt-refused" role="status">Not advertised by your PingOne: its discovery document does not list what this card needs, so the lab does not try it. See <a href="#/settings">Check PingOne</a> in Settings.</p>
      )}
      {needsSignin && (
        <p className="hint" role="status">This card works on your own tokens: <a href="#/run/signin">sign in</a> first.</p>
      )}

      {HINT_CARDS.has(card.id) && (
        <fieldset className="opts">
          <legend>Who signs in</legend>
          <label htmlFor="flow-hint">User (login_hint)<input id="flow-hint" type="text" value={loginHint} placeholder="optional, a PingOne username" onChange={(e) => setLoginHint(e.target.value)} maxLength={256} /></label>
          <p className="hint">Sent to PingOne as login_hint; the sign-in form then starts with this username.</p>
        </fieldset>
      )}
      {card.id === 'ciba' && (
        <fieldset className="opts">
          <legend>Who should approve</legend>
          <label htmlFor="ciba-hint">User (login_hint)<input id="ciba-hint" type="text" value={loginHint} placeholder={signedInAs || 'a PingOne username'} onChange={(e) => setLoginHint(e.target.value)} maxLength={256} aria-describedby="ciba-who" /></label>
          <p id="ciba-who" className={`hint${cibaApprover ? '' : ' pt-refused'}`} role="status">
            {cibaApprover
              ? <>PingOne will ask <strong>{cibaApprover}</strong> to approve{loginHint.trim() ? '' : ' (the signed-in user)'}, through the CIBA authenticator set on the application.</>
              : <>Type the user who should approve, or <a href="#/run/signin">sign in</a> first and leave this empty to use yourself.</>}
          </p>
          <label htmlFor="ciba-msg">Binding message<input id="ciba-msg" type="text" value={bindingMessage} placeholder="optional, e.g. PAY-42" onChange={(e) => setBindingMessage(e.target.value)} maxLength={20} /></label>
        </fieldset>
      )}

      <div className="run-actions">
        <button type="button" className="primary" onClick={start} disabled={run.busy || !card.ready || notAdvertised || (card.id === 'ciba' && !cibaApprover)}>{run.busy ? 'Running...' : 'Run'}</button>
        <button type="button" onClick={reset} disabled={run.busy}>Reset this card</button>
      </div>

      <Steps flow={run.flow} results={run.results} waiting={run.waiting} />
      {pending && run.busy && card.id === 'ciba' && (
        <section className="creds" aria-label="Waiting for approval">
          <p className="creds-title"><strong>PingOne asked {pending.loginHint} to approve</strong>{pending.bindingMessage ? <>: <code>{pending.bindingMessage}</code></> : null}.
            {' '}<span className="hint">The request goes to that user through PingOne's own authenticator (for example a PingOne MFA push). Approve or deny it there; this page keeps polling.</span></p>
        </section>
      )}
      {pending && run.busy && card.id === 'device' && (
        <section className="creds device" aria-label="Enter the code">
          <p className="creds-title"><strong>On another device, enter this code at PingOne:</strong></p>
          <p className="user-code" data-testid="user-code">{pending.userCode}</p>
          {pending.verificationUri
            ? <p><a href={pending.verificationUriComplete || pending.verificationUri} target="_blank" rel="noreferrer noopener">{pending.verificationUri}</a> <span className="hint">(PingOne's own page; this page keeps polling)</span></p>
            : <p className="hint">PingOne's verification address was not on this environment's host, so it is not shown.</p>}
        </section>
      )}
      {run.waiting >= 0 && (
        <Credentials busy={run.busy} refused={waitingResult?.data?.refused} onSubmit={(c) => run.submitCredentials(c)} idPrefix={`${card.id}-cred`} initialUsername={run.results[run.waiting - 1]?.data?.loginHint || ''} />
      )}

      <Proof flowId={card.id} results={run.results} />
      {card.id === 'piflow' && <PiFlowGuide results={run.results} />}

      {CARD_DIAGRAM[card.id] && (
        <details className="how" open>
          <summary>How it works</summary>
          <DiagramView id={CARD_DIAGRAM[card.id]} heading="h4" />
        </details>
      )}
    </article>
  );
}
