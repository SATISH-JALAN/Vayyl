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
  const { withdraw, ragequit, isProving, shieldedBalance, notes, activity, status } = usePoolStore();
  const { address } = useWalletStore();
  const isError = !!status && /failed|error/i.test(status);
  const activeNotes = notes.filter((note) => !note.isSpent);
  const confirmedHash =
    status?.match(/^Withdraw confirmed: ([a-f0-9]{64})$/i)?.[1] ??
    [...activity]
      .filter((event) => event.type === 'Withdraw' && event.txHash)
      .sort((a, b) => b.timestamp - a.timestamp)[0]?.txHash;

  const handleWithdraw = async (e: FormEvent) => {
    e.preventDefault();
    if (!destination) return;

    try {
      await withdraw(destination);
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
        <Input label="Amount" value="1 XLM" disabled readOnly helperText={`${shieldedBalance} XLM available across ${activeNotes.length} active fixed note${activeNotes.length === 1 ? '' : 's'}.`} />

        <Button type="submit" disabled={isProving || !destination || !address || activeNotes.length === 0}>
          {!address ? 'Connect wallet first' : activeNotes.length === 0 ? 'No spendable note' : isProving ? 'Generating proof' : 'Unshield 1 XLM'}
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
              {!destination ? 'Enter a destination above' : isProving ? 'Generating proof' : 'Exit publicly (1 XLM)'}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
