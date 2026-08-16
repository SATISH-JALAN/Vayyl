import { useState, type FormEvent } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';

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
    <Card className="dapp-card--strong">
      <div className="dapp-card__header">
        <div>
          <h2 className="dapp-card__title">Unshield XLM</h2>
          <p className="dapp-card__description">
            Send one note to a funded Stellar account.
          </p>
        </div>
        <span className="dapp-badge dapp-badge--warning">Whole note</span>
      </div>

      <form className="dapp-form" onSubmit={handleWithdraw}>
        <Input
          label="Destination address"
          placeholder="G..."
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          disabled={isProving}
        />
        <div className="dapp-form-group">
          <label className="dapp-label" htmlFor="withdraw-note">Note to unshield</label>
          <select
            id="withdraw-note"
            className="dapp-input"
            value={selected?.id ?? ''}
            onChange={(e) => setSelectedNoteId(e.target.value)}
            disabled={isProving || activeNotes.length === 0}
          >
            {activeNotes.map((note) => (
              <option key={note.id} value={note.id}>
                {fmt(note.amountStroops!)} XLM
              </option>
            ))}
          </select>
          <p className="dapp-helper">
            A withdrawal spends one whole note. To take out part of one, send
            yourself the amount first, then unshield the note that comes back.
          </p>
        </div>

        <Button type="submit" disabled={isProving || !destination || !address || !selected}>
          {!address
            ? 'Connect wallet first'
            : !selected
              ? 'No spendable note'
              : isProving
                ? 'Generating proof'
                : `Unshield ${fmt(selected.amountStroops!)} XLM`}
        </Button>

        {confirmedHash ? (
          <div className="dapp-transaction-confirmation">
            <strong>{status?.startsWith('Withdraw confirmed') ? 'Withdrawal confirmed' : 'Latest withdrawal transaction'}</strong>
            <a href={`https://stellar.expert/explorer/testnet/tx/${confirmedHash}`} target="_blank" rel="noreferrer">
              <code>{confirmedHash}</code>
              <span className="dapp-explorer-brand"><img src="/brands/stellar-expert.png" alt="" />View in Stellar Expert</span>
            </a>
          </div>
        ) : status ? (
          <p className={`dapp-status ${isError ? 'dapp-status--error' : 'dapp-status--success'}`}>{status}</p>
        ) : null}
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
            <Button
              type="button"
              variant="ghost"
              onClick={handleRageQuit}
              disabled={isProving || !destination || !address || !exitAcknowledged || activeNotes.length === 0}
            >
              {!destination ? 'Enter a destination above' : isProving ? 'Generating proof' : 'Exit publicly'}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
