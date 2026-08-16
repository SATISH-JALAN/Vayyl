import { useMemo, useState, type FormEvent } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';
import { decodeShieldedAddress } from '../../lib/address';
import { xlmToStroops } from '../../lib/amount';
import { maxSendableInOneTransfer, totalSpendable } from '../../lib/note-selection';

export default function TransferForm() {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const { transferV3, isProving, notes, activity, status } = usePoolStore();
  const { address } = useWalletStore();

  const isError = !!status && /failed|error/i.test(status);
  const activeNotes = notes.filter((note) => !note.isSpent && note.amountStroops);
  const selectable = activeNotes.map((n) => ({ id: n.id, amountStroops: n.amountStroops! }));

  // Balance and per-transfer ceiling are DIFFERENT numbers, and showing only
  // the balance is how a user hits a confusing failure after waiting out a
  // proof: a transfer spends at most two notes, so a fragmented wallet can hold
  // far more than it can send in one go.
  const balance = totalSpendable(selectable);
  const maxSendable = maxSendableInOneTransfer(selectable);
  const fmt = (v: bigint) => {
    const whole = v / 10_000_000n;
    const frac = (v % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  };

  let amountError: string | null = null;
  let stroops: bigint | null = null;
  if (amount.trim()) {
    try {
      stroops = xlmToStroops(amount);
      if (stroops > maxSendable) {
        amountError =
          `One transfer spends at most two notes, which together hold ` +
          `${fmt(maxSendable)} XLM. Send yourself a payment first to combine them.`;
        stroops = null;
      }
    } catch (e) {
      amountError = (e as Error).message;
    }
  }

  // Validate as the user types. A malformed address would otherwise surface
  // only after a ~10s proof, and one that is well-formed but wrong produces a
  // note nobody can ever open — so this is the place to be loud.
  const addressError = useMemo(() => {
    if (!recipient.trim()) return null;
    try {
      decodeShieldedAddress(recipient);
      return null;
    } catch (e: any) {
      return e.message as string;
    }
  }, [recipient]);

  const recipientValid = !!recipient.trim() && !addressError;

  const confirmedHash =
    status?.match(/^Transfer confirmed: ([a-f0-9]{64})$/i)?.[1] ??
    [...activity]
      .filter((event) => event.type === 'Transfer' && event.txHash)
      .sort((a, b) => b.timestamp - a.timestamp)[0]?.txHash;

  const handleTransfer = async (e: FormEvent) => {
    e.preventDefault();
    if (!recipientValid || !stroops) return;

    try {
      await transferV3(recipient.trim(), stroops.toString());
      setRecipient('');
      setAmount('');
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <Card className="dapp-card--strong">
      <div className="dapp-card__header">
        <div>
          <h2 className="dapp-card__title">Send privately</h2>
          <p className="dapp-card__description">
            Send any amount to another Vayyl address. Nothing leaves the pool,
            the amount never touches the ledger, and neither party appears on it.
          </p>
        </div>
        <span className="dapp-badge dapp-badge--success">Amount hidden</span>
      </div>

      <form className="dapp-form" onSubmit={handleTransfer}>
        <Input
          label="Recipient shielded address"
          placeholder="VAYYL..."
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          disabled={isProving}
          helperText={
            addressError ??
            'The recipient discovers this payment automatically — you do not need to send them anything.'
          }
        />
        <Input
          label="Amount"
          placeholder="0.0"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={isProving}
          helperText={
            amountError ??
            `${fmt(balance)} XLM across ${activeNotes.length} note${activeNotes.length === 1 ? '' : 's'}` +
            (maxSendable < balance ? ` · up to ${fmt(maxSendable)} XLM in one send` : '')
          }
        />

        <Button
          type="submit"
          disabled={isProving || !recipientValid || !stroops || !address || activeNotes.length === 0}
        >
          {!address
            ? 'Connect wallet first'
            : activeNotes.length === 0
              ? 'No spendable note'
              : isProving
                ? 'Generating proof'
                : !stroops
                  ? 'Enter an amount'
                  : `Send ${amount} XLM privately`}
        </Button>

        {confirmedHash ? (
          <div className="dapp-transaction-confirmation">
            <strong>
              {status?.startsWith('Transfer confirmed') ? 'Transfer confirmed' : 'Latest transfer transaction'}
            </strong>
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
