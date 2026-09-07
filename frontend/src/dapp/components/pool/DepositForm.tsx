import { useState, type FormEvent } from 'react';

import AmountField from './AmountField';
import Receipt from './Receipt';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';
import { xlmToStroops } from '../../lib/amount';

/** Conveniences, not balances — this page never reads the account's public XLM. */
const PRESETS = ['10', '25', '50', '100'];

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
    <section className="vy-composer">
      <header className="vy-composer__head">
        <div>
          <h2>Shield XLM</h2>
          <p>Move public XLM into the pool as a spendable note.</p>
        </div>
        <span className="vy-badge">Any amount</span>
      </header>

      <form className="vy-composer__body" onSubmit={handleDeposit}>
        <AmountField
          value={amount}
          onChange={setAmount}
          disabled={isProving}
          invalid={!!parseError}
          presets={PRESETS}
          hint={
            parseError ??
            'Up to 7 decimal places. The deposit itself is public; privacy starts when you send.'
          }
        />

        <button
          type="submit"
          className="vy-composer__submit"
          disabled={isProving || !address || !stroops}
        >
          {!address
            ? 'Connect wallet first'
            : isProving
              ? 'Generating proof…'
              : !stroops
                ? 'Enter an amount'
                : aspEligible === false
                  ? `Prepare & shield ${amount} XLM`
                  : `Shield ${amount} XLM`}
        </button>

        <Receipt
          confirmedHash={confirmedHash}
          confirmed={status?.startsWith('Deposit confirmed')}
          confirmedLabel="Deposit confirmed"
          latestLabel="Latest shield transaction"
          status={status}
          isError={isError}
        />
      </form>
    </section>
  );
}
