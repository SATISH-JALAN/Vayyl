import { useState, type FormEvent } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';

export default function WithdrawForm() {
  const [destination, setDestination] = useState('');
  const { withdraw, isProving, shieldedBalance, notes, activity, status } = usePoolStore();
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
    </Card>
  );
}
