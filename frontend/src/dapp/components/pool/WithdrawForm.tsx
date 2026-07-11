import { useState, type FormEvent } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';

export default function WithdrawForm() {
  const [amount, setAmount] = useState('');
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
    if (!amount || !destination) return;

    try {
      await withdraw(amount, 'XLM', destination);
      setAmount('');
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
            Withdraw one exact unspent note to a public Stellar address.
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
        <Input
          label="Amount"
          type="number"
          inputMode="decimal"
          min="0.0000001"
          step="0.0000001"
          placeholder="0.10"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={isProving}
          helperText={`${shieldedBalance} XLM available across ${activeNotes.length} active note${activeNotes.length === 1 ? '' : 's'}.`}
        />

        <Button type="submit" disabled={isProving || !amount || !destination || !address}>
          {!address ? 'Connect wallet first' : isProving ? 'Generating proof' : 'Unshield XLM'}
        </Button>

        {confirmedHash ? (
          <div className="dapp-transaction-confirmation">
            <strong>{status?.startsWith('Withdraw confirmed') ? 'Withdrawal confirmed on Mainnet' : 'Latest withdrawal transaction'}</strong>
            <a href={`https://stellar.expert/explorer/public/tx/${confirmedHash}`} target="_blank" rel="noreferrer">
              <code>{confirmedHash}</code>
              <span>View in Stellar Expert</span>
            </a>
          </div>
        ) : status ? (
          <p className={`dapp-status ${isError ? 'dapp-status--error' : 'dapp-status--success'}`}>{status}</p>
        ) : null}
      </form>
    </Card>
  );
}
