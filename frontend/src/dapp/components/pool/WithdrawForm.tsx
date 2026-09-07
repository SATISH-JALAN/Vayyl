import { useState, type FormEvent } from 'react';

import Receipt from './Receipt';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';
import { shortHash } from '../../lib/format';

export default function WithdrawForm() {
  const [destination, setDestination] = useState('');
  const [showExit, setShowExit] = useState(false);
  const [exitAcknowledged, setExitAcknowledged] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState('');
  const { withdrawV3, ragequit, isProving, notes, activity, status } = usePoolStore();
  const { address } = useWalletStore();
  const isError = !!status && /failed|error/i.test(status);
  // Withdraw spends ONE WHOLE note: there is no change circuit on this path.
  // So the user picks a note rather than typing an amount, which makes the
  // constraint obvious instead of surfacing it as a rejected amount.
  const activeNotes = notes.filter((note) => !note.isSpent && note.amountStroops);
  const fmt = (raw: string) => {
    const v = BigInt(raw);
    const whole = v / 10_000_000n;
    const frac = (v % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  };
  const selected = activeNotes.find((n) => n.id === selectedNoteId) ?? activeNotes[0];
  const confirmedHash =
    status?.match(/^Withdraw confirmed: ([a-f0-9]{64})$/i)?.[1] ??
    [...activity]
      .filter((event) => event.type === 'Withdraw' && event.txHash)
      .sort((a, b) => b.timestamp - a.timestamp)[0]?.txHash;

  const handleWithdraw = async (e: FormEvent) => {
    e.preventDefault();
    if (!destination || !selected) return;

    try {
      await withdrawV3(destination, selected.amountStroops!);
      setDestination('');
    } catch (error) {
      console.error(error);
    }
  };

  const handleRageQuit = async () => {
    if (!destination || !exitAcknowledged) return;
    try {
      await ragequit(destination);
      setDestination('');
      setShowExit(false);
      setExitAcknowledged(false);
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <section className="vy-composer">
      <header className="vy-composer__head">
        <div>
          <h2>Unshield XLM</h2>
          <p>Send one whole note to a funded Stellar account.</p>
        </div>
        <span className="vy-badge vy-badge--warn">Whole note</span>
      </header>

      <form className="vy-composer__body" onSubmit={handleWithdraw}>
        <div className="vy-field">
          <label className="vy-field-label" htmlFor="withdraw-destination">
            Destination address
          </label>
          <input
            id="withdraw-destination"
            className="vy-text-input dapp-mono"
            placeholder="G…"
            autoComplete="off"
            spellCheck={false}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            disabled={isProving}
          />
          <p className="vy-field-hint">
            This address and the amount are public. The link back to your deposit is not.
          </p>
        </div>

        {/* Picked from a list rather than a <select>, because the amount is the
            thing being chosen and a collapsed dropdown hides exactly that. The
            constraint -- one whole note, no partial exit -- is legible when the
            notes are laid out as the discrete objects they are. */}
        <div className="vy-field">
          <span className="vy-field-label">Note to unshield</span>
          {activeNotes.length === 0 ? (
            <p className="vy-field-hint">
              No spendable note yet. Shield XLM first, or wait for an incoming payment to be
              scanned.
            </p>
          ) : (
            <div className="vy-notepick" role="radiogroup" aria-label="Note to unshield">
              {activeNotes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  role="radio"
                  aria-checked={selected?.id === note.id}
                  className={`vy-notepick__item ${selected?.id === note.id ? 'is-active' : ''}`.trim()}
                  onClick={() => setSelectedNoteId(note.id)}
                  disabled={isProving}
                >
                  <strong className="dapp-mono">{fmt(note.amountStroops!)} XLM</strong>
                  <small className="dapp-mono" title={note.commitment}>
                    leaf #{note.leafIndex} · {shortHash(note.commitment, 6, 4)}
                  </small>
                </button>
              ))}
            </div>
          )}
          {/* Only alongside actual notes. With none to pick, the line above
              already says what to do, and stacking both read as two answers to
              a question the user had not asked yet. */}
          {activeNotes.length > 0 && (
            <p className="vy-field-hint">
              A withdrawal spends one whole note. To take out part of one, send yourself the
              amount first, then unshield the note that comes back.
            </p>
          )}
        </div>

        <button
          type="submit"
          className="vy-composer__submit"
          disabled={isProving || !destination || !address || !selected}
        >
          {!address
            ? 'Connect wallet first'
            : !selected
              ? 'No spendable note'
              : isProving
                ? 'Generating proof…'
                : !destination
                  ? 'Enter a destination'
                  : `Unshield ${fmt(selected.amountStroops!)} XLM`}
        </button>

        <Receipt
          confirmedHash={confirmedHash}
          confirmed={status?.startsWith('Withdraw confirmed')}
          confirmedLabel="Withdrawal confirmed"
          latestLabel="Latest withdrawal transaction"
          status={status}
          isError={isError}
        />
      </form>

      {/*
        The escape hatch. A private unshield is refused if the note's nullifier
        is on the approval-set blocklist; without this route those funds would be
        stuck permanently, which is a worse outcome than the one the blocklist
        guards against. It is offered to everyone rather than only to blocked
        users, because detecting "you are blocked" client-side would leak the
        blocklist and be unreliable anyway. The cost is stated plainly up front,
        and the confirmation is required — nobody should give up their privacy by
        misclicking.
      */}
      <div className="dapp-exit">
        <button
          type="button"
          className="dapp-exit__toggle"
          onClick={() => setShowExit((open) => !open)}
          aria-expanded={showExit}
        >
          {showExit ? 'Hide public exit' : 'Unshield blocked? Use a public exit'}
        </button>

        {showExit ? (
          <div className="dapp-exit__body">
            <p className="dapp-exit__warning">
              A public exit releases your note without privacy. The deposit and the
              destination address are linked on the Stellar ledger permanently, and
              that link cannot be undone. Use it only if a normal unshield is being
              refused.
            </p>
            <label className="dapp-exit__ack">
              <input
                type="checkbox"
                checked={exitAcknowledged}
                onChange={(e) => setExitAcknowledged(e.target.checked)}
                disabled={isProving}
              />
              I understand this exit is public and permanent.
            </label>
            <button
              type="button"
              className="dapp-button dapp-button--ghost"
              onClick={handleRageQuit}
              disabled={isProving || !destination || !address || !exitAcknowledged || activeNotes.length === 0}
            >
              {!destination ? 'Enter a destination above' : isProving ? 'Generating proof…' : 'Exit publicly'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
