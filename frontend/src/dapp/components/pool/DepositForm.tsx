import { useState, type FormEvent } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';

export default function DepositForm() {
  const [amount, setAmount] = useState('');
  const { deposit, isProving, notes, status } = usePoolStore();
  const { address } = useWalletStore();
  const isError = !!status && /failed|error/i.test(status);
  const confirmedHash =
    status?.match(/^Deposit confirmed: ([a-f0-9]{64})$/i)?.[1] ??
    [...notes].sort((a, b) => b.createdAt - a.createdAt).find((note) => note.txHash)?.txHash;

  const handleDeposit = async (e: FormEvent) => {
    e.preventDefault();
    if (!amount) return;

    try {
      await deposit(amount, 'XLM');
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
            min="0.0000001"
            step="0.0000001"
            placeholder="0.10"
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

        {confirmedHash ? (
          <div className="dapp-transaction-confirmation">
            <strong>{status?.startsWith('Deposit confirmed') ? 'Deposit confirmed on Mainnet' : 'Latest shield transaction'}</strong>
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
