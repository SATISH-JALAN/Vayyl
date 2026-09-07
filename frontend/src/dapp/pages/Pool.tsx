import { useEffect, useMemo, useState, type ReactNode } from 'react';

import AssetLogo from '../components/common/AssetLogo';
import DepositForm from '../components/pool/DepositForm';
import TransferForm from '../components/pool/TransferForm';
import WithdrawForm from '../components/pool/WithdrawForm';
import FlowSummary, { type FlowMode } from '../components/pool/FlowSummary';
import { usePoolStore } from '../store/pool';
import { useWalletStore } from '../store/wallet';
import { encodeShieldedAddress } from '../lib/address';
import { getMarket } from '../lib/assets';
import { EXPLORER_TX, relativeTime, shortHash } from '../lib/format';
import type { ActivityEvent, ShieldedNote } from '../lib/storage';

type LedgerTab = 'notes' | 'activity';

/**
 * The three actions, named AND explained.
 *
 * "Shield / Send / Unshield" are the protocol's words, not the reader's. Three
 * equal grey rectangles gave someone arriving here nothing to choose between,
 * so each mode now carries the one line that says what it does to their money
 * and to their privacy.
 */
const MODES: Array<{ id: FlowMode; label: string; hint: string; icon: ReactNode }> = [
  {
    id: 'deposit',
    label: 'Shield',
    hint: 'Public XLM in',
    icon: (
      <>
        <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z" />
        <path d="M9 12l2 2 4-4" />
      </>
    ),
  },
  {
    id: 'transfer',
    label: 'Send',
    hint: 'Private, in-pool',
    icon: (
      <>
        <path d="M4 12h13" />
        <path d="M13 7l5 5-5 5" />
        <path d="M20 4v16" />
      </>
    ),
  },
  {
    id: 'withdraw',
    label: 'Unshield',
    hint: 'Public XLM out',
    icon: (
      <>
        <path d="M20 12H7" />
        <path d="M11 7l-5 5 5 5" />
        <path d="M4 4v16" />
      </>
    ),
  },
];

/**
 * Private payments.
 *
 * Built from the SAME vocabulary as the positions terminal -- `.vy-market` for
 * the stat header, `.vy-summary` for the flow panel, `.vy-tabs` + `.vy-table`
 * for the ledger -- rather than a second look for the same product.
 *
 * Every figure here is read, not decorative. The balance and note count come
 * from this wallet's own notes, the anonymity set is read live from the pool
 * contract (which is also what enforces the withdrawal floor), and the ASP row
 * reports whether THIS wallet's leaf is in the membership tree -- because a
 * deposit whose asp_root the tree never produced is rejected on-chain.
 */
export default function Pool() {
  const [activeMode, setActiveMode] = useState<FlowMode>('deposit');
  const [tab, setTab] = useState<LedgerTab>('notes');
  const [copied, setCopied] = useState(false);
  const keys = useWalletStore((state) => state.keys);
  const { fetchState, anonymitySet, shieldedBalance, notes, activity, aspEligible, aspLeafIndex } =
    usePoolStore();

  const market = getMarket('xlm-usd');
  const unspent = useMemo(() => notes.filter((n) => !n.isSpent), [notes]);

  useEffect(() => {
    if (keys) void fetchState();
  }, [keys, fetchState]);

  // Derived from the wallet's shielded key, so it appears only after unlock and
  // is never something the user has to create or remember.
  const shieldedAddress = useMemo(() => {
    if (!keys) return null;
    try {
      return encodeShieldedAddress({ pubX: keys.pubX, pubY: keys.pubY });
    } catch {
      return null;
    }
  }, [keys]);

  const copyAddress = async () => {
    if (!shieldedAddress) return;
    await navigator.clipboard.writeText(shieldedAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // The meter is drawn against the floor the CONTRACT enforces on withdrawal,
  // not against an invented target. With no floor there is nothing to fill
  // toward and the bar is not drawn at all: a progress bar with a made-up
  // denominator would be a claim about privacy that nothing on-chain backs.
  const floor = anonymitySet?.floor ?? 0;
  const met = anonymitySet ? anonymitySet.unspent >= floor : false;
  const fill =
    floor > 0 && anonymitySet
      ? Math.min(100, Math.round((anonymitySet.unspent / floor) * 100))
      : null;

  return (
    <div className="vy-pay">
      {/* The same panel the terminal uses for its market header, carrying the
          page title too. A separate .dapp-page-header above it would print
          "Private Payments" twice -- the shell topbar already names the page --
          and spend about ninety pixels doing it. */}
      <div className="vy-market">
        <h1 className="vy-market__pair">
          <span className="vy-market__pair-icon">
            <AssetLogo asset={market.base} size={22} />
          </span>
          <span>
            <strong>Private Payments</strong>
            <small>Shielded XLM · Poseidon2 · Merkle depth 20</small>
          </span>
        </h1>

        <dl className="vy-market__stats">
          <div className="vy-stat">
            <dt>Your shielded balance</dt>
            <dd className="dapp-mono">
              {keys ? `${shieldedBalance} XLM` : '—'}
              <small>
                {keys
                  ? `${unspent.length} unspent note${unspent.length === 1 ? '' : 's'}`
                  : 'unlock to read'}
              </small>
            </dd>
          </div>

          <div className="vy-stat">
            <dt>Anonymity set</dt>
            <dd className="dapp-mono">
              {anonymitySet ? anonymitySet.unspent : '—'}
              <small>{floor > 0 ? `withdrawal floor ${floor}` : 'no floor enforced'}</small>
            </dd>
          </div>

          <div className="vy-stat">
            <dt>ASP screening</dt>
            <dd>
              {aspEligible === null ? (
                <span className="vy-badge" title="Unlock your keys to check this wallet's leaf.">
                  unknown
                </span>
              ) : aspEligible ? (
                <span
                  className="vy-badge vy-badge--ok"
                  title="This wallet's leaf is in the membership tree, so the pool will accept its deposits."
                >
                  enrolled · leaf {aspLeafIndex}
                </span>
              ) : (
                <span
                  className="vy-badge vy-badge--warn"
                  title="Shielding enrols this wallet automatically through the relayer. Until then the pool rejects the deposit with InvalidAspRoot."
                >
                  enrols on first shield
                </span>
              )}
            </dd>
          </div>

          <div className="vy-stat">
            <dt>Proof system</dt>
            <dd>
              <span
                className="vy-badge"
                title="Groth16 over BN254, verified by Soroban's native host functions"
              >
                Groth16 · BN254
              </span>
            </dd>
          </div>
        </dl>
      </div>

      <div className="vy-pay__grid">
        <div className="vy-pay__col">
          <div className="vy-modes" role="tablist" aria-label="Shielded pool action">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="tab"
                aria-selected={activeMode === mode.id}
                className={`vy-mode ${activeMode === mode.id ? 'is-active' : ''}`.trim()}
                onClick={() => setActiveMode(mode.id)}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {mode.icon}
                </svg>
                <span>
                  <strong>{mode.label}</strong>
                  <small>{mode.hint}</small>
                </span>
              </button>
            ))}
          </div>

          {activeMode === 'deposit' ? <DepositForm />
            : activeMode === 'transfer' ? <TransferForm />
              : <WithdrawForm />}

          {/* The same ledger the terminal puts under its chart. It fills what
              used to be dead space below the form, and it answers "did that
              actually happen": every row is either a note this wallet can spend
              or an event it has recorded. */}
          <section className="vy-terminal__ledger" aria-label="Your notes and activity">
            <div className="vy-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'notes'}
                className={`vy-tabs__tab ${tab === 'notes' ? 'is-active' : ''}`.trim()}
                onClick={() => setTab('notes')}
              >
                Notes
                <span className="vy-tabs__count">{unspent.length}</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={tab === 'activity'}
                className={`vy-tabs__tab ${tab === 'activity' ? 'is-active' : ''}`.trim()}
                onClick={() => setTab('activity')}
              >
                Activity
                <span className="vy-tabs__count">{activity.length}</span>
              </button>

              {keys && (
                <div className="vy-tabs__right">
                  <div className="vy-tabs__summary">
                    <span>
                      Shielded <strong className="dapp-mono">{shieldedBalance} XLM</strong>
                    </span>
                    <span>
                      Spent <strong className="dapp-mono">{notes.length - unspent.length}</strong>
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="vy-tabs__panel">
              {!keys ? (
                <div className="vy-empty">
                  <strong>Unlock your private workspace</strong>
                  <span>
                    Notes are decrypted locally with your viewing key. Nothing here is readable
                    until you unlock — including by us.
                  </span>
                </div>
              ) : tab === 'notes' ? (
                <NotesTable notes={unspent} />
              ) : (
                <ActivityTable activity={activity} />
              )}
            </div>
          </section>
        </div>

        <aside className="vy-pay__col vy-pay__side">
          {/* Changes with the mode. The right column used to be two static
              paragraphs that said the same thing whatever the user was doing. */}
          <FlowSummary mode={activeMode} />

          {/*
            The crowd, stated before the user commits funds rather than after.
            Cryptography gives unlinkability WITHIN a set and cannot manufacture
            the set, so a pool holding a handful of notes offers little practical
            privacy however sound the proofs are. Most shielded pools leave this
            implicit and let users assume a guarantee the size does not support.
            Read live from the pool, which is also what enforces the floor.
          */}
          <section className="vy-panel">
            <header className="vy-panel__head">
              <h2>Anonymity set</h2>
              {anonymitySet ? (
                <span className={`vy-badge ${met ? 'vy-badge--ok' : 'vy-badge--warn'}`}>
                  {anonymitySet.unspent} note{anonymitySet.unspent === 1 ? '' : 's'}
                </span>
              ) : null}
            </header>

            <div className="vy-panel__body">
              {fill !== null && (
                <div
                  className="vy-meter"
                  role="img"
                  aria-label={`${anonymitySet?.unspent ?? 0} of ${floor} notes required to withdraw`}
                >
                  <span
                    className={`vy-meter__fill ${met ? 'is-ok' : 'is-low'}`}
                    style={{ width: `${fill}%` }}
                  />
                </div>
              )}

              <p className="vy-field-hint">
                {!anonymitySet
                  ? 'This pool does not report a set size, so the crowd you are hiding in cannot be verified from here.'
                  : anonymitySet.floor === 0
                    ? `No minimum is enforced on this pool. At ${anonymitySet.unspent} unspent ` +
                      `note${anonymitySet.unspent === 1 ? '' : 's'}, treat timing and amount ` +
                      `correlation as the real risk rather than the cryptography.`
                    : anonymitySet.unspent < anonymitySet.floor
                      ? `Withdrawals are paused until the pool holds ${anonymitySet.floor} unspent ` +
                        `notes. Deposits and private sends still work, and the public exit is never blocked.`
                      : `Above the enforced minimum of ${anonymitySet.floor}. Withdrawals are open.`}
              </p>
            </div>
          </section>

          <section className="vy-panel">
            <header className="vy-panel__head">
              <h2>Your shielded address</h2>
              {shieldedAddress && (
                <button type="button" className="vy-panel__action" onClick={copyAddress}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
            </header>

            <div className="vy-panel__body">
              {shieldedAddress ? (
                <code className="vy-addr dapp-mono">{shieldedAddress}</code>
              ) : (
                <p className="vy-field-hint">
                  Connect and unlock to derive your shielded address. It is not a Stellar account
                  and never appears on the ledger.
                </p>
              )}

              <ol className="vy-steps">
                <li>Payments to this address arrive automatically.</li>
                <li>Export an encrypted backup from Settings.</li>
                <li>Unshield to any funded Stellar account.</li>
              </ol>

              <a className="vy-panel__link" href="/app?view=settings">
                Manage backup →
              </a>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function NotesTable({ notes }: { notes: ShieldedNote[] }) {
  if (notes.length === 0) {
    return (
      <div className="vy-empty">
        <strong>No spendable notes yet</strong>
        <span>
          Shield XLM to create your first note. It becomes spendable as soon as the deposit
          confirms.
        </span>
      </div>
    );
  }

  return (
    <div className="vy-table-wrap">
      <table className="vy-table">
        <thead>
          <tr>
            <th>Note</th>
            <th>Amount</th>
            <th>Leaf</th>
            <th>Protocol</th>
            <th>Origin</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((note) => (
            <tr key={note.id}>
              <td className="dapp-mono" title={note.commitment}>
                {shortHash(note.commitment)}
              </td>
              <td className="dapp-mono">
                {note.amount} {note.asset}
              </td>
              <td className="dapp-mono">#{note.leafIndex}</td>
              <td>{(note.protocol ?? 'v2').toUpperCase()}</td>
              <td>{note.source === 'received' ? 'Received' : 'Shielded'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="vy-table__note">
        Note secrets never leave this browser. Spent status is reconciled against the pool&apos;s
        on-chain nullifier set, so a note spent from another device stops appearing here.
      </p>
    </div>
  );
}

function ActivityTable({ activity }: { activity: ActivityEvent[] }) {
  if (activity.length === 0) {
    return (
      <div className="vy-empty">
        <strong>Nothing recorded yet</strong>
        <span>Shields, private sends and unshields appear here with a link to the transaction.</span>
      </div>
    );
  }

  return (
    <div className="vy-table-wrap">
      <table className="vy-table">
        <thead>
          <tr>
            <th>Event</th>
            <th>Amount</th>
            <th>When</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {activity.map((event) => (
            <tr key={`${event.type}-${event.id}`}>
              <td>{event.type}</td>
              <td className="dapp-mono">
                {event.amount} {event.asset}
              </td>
              <td>{relativeTime(event.timestamp)}</td>
              <td className="dapp-mono">
                {event.txHash ? (
                  <a href={`${EXPLORER_TX}/${event.txHash}`} target="_blank" rel="noreferrer">
                    {shortHash(event.txHash)}
                  </a>
                ) : (
                  <span title="Recorded locally; this event had no separate transaction of its own.">
                    local
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
