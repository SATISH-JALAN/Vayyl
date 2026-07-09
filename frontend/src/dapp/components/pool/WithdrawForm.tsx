import { useState, type FormEvent } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';

export default function WithdrawForm() {
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const { withdraw, isProving, shieldedBalance, notes, status } = usePoolStore();
  const { address } = useWalletStore();
  const isError = !!status && /failed|error/i.test(status);
  const activeNotes = notes.filter((note) => !note.isSpent);

  const handleWithdraw = async (e: FormEvent) => {
    e.preventDefault();
    if (!amount || !destination) return;

    try {
      await withdraw(Number(amount), 'XLM', destination);
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
          min="0"
          step="1"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={isProving}
          helperText={`${shieldedBalance} XLM available across ${activeNotes.length} active note${activeNotes.length === 1 ? '' : 's'}.`}
        />

        <Button type="submit" disabled={isProving || !amount || !destination || !address}>
          {!address ? 'Connect wallet first' : isProving ? 'Generating proof' : 'Unshield XLM'}
        </Button>

        {status && <p className={`dapp-status ${isError ? 'dapp-status--error' : 'dapp-status--success'}`}>{status}</p>}
      </form>
    </Card>
  );
}
