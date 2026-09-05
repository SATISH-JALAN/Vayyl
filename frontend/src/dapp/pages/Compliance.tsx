'use client';

import { useEffect, useState, type FormEvent } from 'react';

import Card from '../components/common/Card';
import Button from '../components/common/Button';
import { checkCommitment, fetchAspState, type AspSet, type AspState } from '../lib/asp';
import { NETWORK } from '../lib/network';

const explorer = (id: string) =>
  `https://stellar.expert/explorer/${NETWORK.toLowerCase()}/contract/${id}`;

/**
 * Compliance (ASP).
 *
 * The association sets are the part of this protocol people are most entitled
 * to be sceptical about: "screened deposits" is a claim, and a claim about
 * screening that cannot be checked is worth nothing. So this page reads the two
 * deployed contracts directly — simulated calls, no wallet, no signature, no
 * fee — and links each root to an explorer, so the number shown here can be
 * compared against the ledger by someone who does not trust this app.
 *
 * There is no admin control here. Enrolment is the set operator's write, not
 * the DApp's, and rendering a button for it would misdescribe who holds that
 * key.
 */
export default function Compliance() {
  const [state, setState] = useState<AspState | null>(null);
  const [loading, setLoading] = useState(true);
  const [leaf, setLeaf] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchAspState()
      .then((s) => {
        if (live) setState(s);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const onCheck = async (e: FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setResult(null);
    try {
      const { enrolled, blocked } = await checkCommitment(leaf);
      // Each set is reported separately, and "we could not ask" is never
      // rendered as "no". On a compliance page those are different answers.
      const parts = [
        enrolled === null
          ? 'Allow-list: did not answer.'
          : enrolled
            ? 'Allow-list: enrolled — a deposit can prove membership.'
            : 'Allow-list: not enrolled — the deposit circuit would reject it.',
        blocked === null
          ? 'Deny-list: did not answer.'
          : blocked
            ? 'Deny-list: blocked.'
            : 'Deny-list: not blocked.',
      ];
      setResult({ ok: enrolled === true && blocked === false, text: parts.join(' ') });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Compliance (ASP)</h1>
          <p className="dapp-page-subtitle">
            Association sets gate which notes may enter and leave the shielded pool. Both roots
            below are read live from the contracts — nothing on this page comes from the app&apos;s
            own state.
          </p>
        </div>
      </header>

      {loading && <p className="dapp-status">Reading the association sets from the chain…</p>}

      {state && (
        <div className="dapp-grid dapp-grid--overview">
          <AspCard
            title="Allow-list"
            description="asp-membership — a deposit proves its commitment is a leaf of this tree."
            set={state.membership}
            error={state.errors.membership}
          />
          <AspCard
            title="Deny-list"
            description="asp-non-membership — a withdrawal proves its commitment is not a leaf."
            set={state.nonMembership}
            error={state.errors.nonMembership}
          />
        </div>
      )}

      <Card>
        <div className="dapp-card__header">
          <div>
            <h2 className="dapp-card__title">Check a commitment</h2>
            <p className="dapp-card__description">
              Answered by the contract, not by this app. The lookup is a simulated read: it costs
              nothing, signs nothing, and is not recorded anywhere.
            </p>
          </div>
        </div>

        <form className="vy-asp-form" onSubmit={onCheck}>
          <input
            className="dapp-input dapp-mono"
            value={leaf}
            onChange={(e) => setLeaf(e.target.value)}
            placeholder="Commitment — 64 hex characters"
            spellCheck={false}
            aria-label="Commitment"
          />
          <Button type="submit" variant="ghost" disabled={checking || leaf.trim() === ''}>
            {checking ? 'Checking…' : 'Check'}
          </Button>
        </form>

        {result && (
          <p className={`dapp-status ${result.ok ? 'dapp-status--success' : 'dapp-status--error'}`} role="status">
            {result.text}
          </p>
        )}
      </Card>
    </div>
  );
}

function AspCard({
  title,
  description,
  set,
  error,
}: {
  title: string;
  description: string;
  set: AspSet | null;
  error: string | null;
}) {
  return (
    <Card>
      <div className="dapp-card__header">
        <div>
          <h2 className="dapp-card__title">{title}</h2>
          <p className="dapp-card__description">{description}</p>
        </div>
      </div>

      {set ? (
        <dl className="vy-asp-facts">
          <div>
            <dt>Root</dt>
            <dd className="dapp-mono vy-asp-root">{set.root}</dd>
          </div>
          <div>
            <dt>{set.countLabel}</dt>
            <dd className="dapp-mono">{set.count.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Contract</dt>
            <dd>
              <a
                className="dapp-mono"
                href={explorer(set.contractId)}
                target="_blank"
                rel="noreferrer"
              >
                {set.contractId.slice(0, 8)}…{set.contractId.slice(-6)}
              </a>
            </dd>
          </div>
        </dl>
      ) : (
        // A set that did not answer is NOT a set with zero leaves, and printing
        // 0 here would read as "nothing is screened".
        <p className="dapp-status dapp-status--error">
          This set did not respond, so its state is unknown — not empty.
          {error && <code> {error}</code>}
        </p>
      )}
    </Card>
  );
}
