import { useState, type FormEvent } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';
import { xlmToStroops } from '../../lib/amount';

export default function DepositForm() {
  const [amount, setAmount] = useState('');
  const { depositV3, isProving, notes, status, aspEligible } = usePoolStore();
  const { address } = useWalletStore();
  const isError = !!status && /failed|error/i.test(status);
  const confirmedHash =
    status?.match(/^Deposit confirmed: ([a-f0-9]{64})$/i)?.[1] ??
    [...notes].sort((a, b) => b.createdAt - a.createdAt).find((note) => note.txHash)?.txHash;

  // Parsed for validation only. The store is given stroops as a decimal string
  // and never a number: stroops are i128 on-chain, and anything above 2^53
  // loses precision in a JS number with no error anywhere to show for it.
  let parseError: string | null = null;
  let stroops: bigint | null = null;
  if (amount.trim()) {
    try {
      stroops = xlmToStroops(amount);
    } catch (e) {
      parseError = (e as Error).message;
    }
  }

  const handleDeposit = async (e: FormEvent) => {
    e.preventDefault();
    if (!stroops) return;
    try {
      await depositV3(stroops.toString());
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
            Create a spendable note for this wallet.
          </p>
        </div>
        <span className="dapp-badge dapp-badge--success">Deposit</span>
      </div>

      <form className="dapp-form" onSubmit={handleDeposit}>
        <div className="dapp-form-row">
          <Input
            label="Amount"
            placeholder="0.0"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={isProving}
            helperText={
              parseError ??
              'Any amount, up to 7 decimal places. The deposit itself is public; ' +
              'privacy starts when you send.'
            }
          />
          <Input label="Asset" value="XLM" disabled readOnly />
        </div>

        <Button type="submit" disabled={isProving || !address || !stroops}>
          {!address
            ? 'Connect wallet first'
            : isProving
              ? 'Generating proof'
              : !stroops
                ? 'Enter an amount'
                : aspEligible === false
                  ? `Prepare & shield ${amount} XLM`
                  : `Shield ${amount} XLM`}
        </Button>

        {confirmedHash ? (
          <div className="dapp-transaction-confirmation">
            <strong>{status?.startsWith('Deposit confirmed') ? 'Deposit confirmed' : 'Latest shield transaction'}</strong>
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
