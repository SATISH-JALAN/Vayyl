import { useState, type FormEvent } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';

export default function DepositForm() {
  const [amount, setAmount] = useState('');
  const { deposit, isProving, status } = usePoolStore();
  const { address } = useWalletStore();
  const isError = !!status && /failed|error/i.test(status);

  const handleDeposit = async (e: FormEvent) => {
    e.preventDefault();
    if (!amount) return;

    try {
      await deposit(Number(amount), 'XLM');
      setAmount('');
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <Card className="dapp-card--strong">
      <div className="dapp-card__header">
        <div>
          <h2 className="dapp-card__title">Shield XLM</h2>
          <p className="dapp-card__description">
            Deposit XLM into the pool and create a locally spendable shielded note.
          </p>
        </div>
        <span className="dapp-badge dapp-badge--success">Deposit</span>
      </div>

      <form className="dapp-form" onSubmit={handleDeposit}>
        <div className="dapp-form-row">
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
            helperText="Use an amount that can be settled as a single shielded note."
          />
          <Input label="Asset" value="XLM" disabled readOnly />
        </div>

        <Button type="submit" disabled={isProving || !amount || !address}>
          {!address ? 'Connect wallet first' : isProving ? 'Generating proof' : 'Shield XLM'}
        </Button>

        {status && <p className={`dapp-status ${isError ? 'dapp-status--error' : 'dapp-status--success'}`}>{status}</p>}
      </form>
    </Card>
  );
}
