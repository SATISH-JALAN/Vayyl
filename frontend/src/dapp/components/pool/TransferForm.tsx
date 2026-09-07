import { useMemo, useState, type FormEvent } from 'react';

import AmountField from './AmountField';
import Receipt from './Receipt';
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
    <section className="vy-composer">
      <header className="vy-composer__head">
        <div>
          <h2>Send privately</h2>
          <p>Pay another Vayyl address without either party touching the ledger.</p>
        </div>
        <span className="vy-badge vy-badge--ok">Amount hidden</span>
      </header>

      <form className="vy-composer__body" onSubmit={handleTransfer}>
        <div className="vy-field">
          <label className="vy-field-label" htmlFor="transfer-recipient">
            Recipient shielded address
          </label>
          <input
            id="transfer-recipient"
            className={`vy-text-input dapp-mono ${addressError ? 'is-invalid' : ''}`.trim()}
            placeholder="VAYYL…"
            autoComplete="off"
            spellCheck={false}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            disabled={isProving}
            aria-invalid={!!addressError || undefined}
          />
          <p className={`vy-field-hint ${addressError ? 'is-error' : ''}`.trim()}>
            {addressError ??
              'The recipient discovers this payment automatically — you do not need to send them anything.'}
          </p>
        </div>

        <AmountField
          value={amount}
          onChange={setAmount}
          disabled={isProving}
          invalid={!!amountError}
          max={maxSendable > 0n ? { label: 'Max', value: fmt(maxSendable) } : null}
          hint={
            amountError ??
            `${fmt(balance)} XLM across ${activeNotes.length} note${activeNotes.length === 1 ? '' : 's'}` +
              (maxSendable < balance ? ` · up to ${fmt(maxSendable)} XLM in one send` : '')
          }
        />

        <button
          type="submit"
          className="vy-composer__submit"
          disabled={isProving || !recipientValid || !stroops || !address || activeNotes.length === 0}
        >
          {!address
            ? 'Connect wallet first'
            : activeNotes.length === 0
              ? 'No spendable note'
              : isProving
                ? 'Generating proof…'
                : !recipientValid
                  ? 'Enter a recipient'
                  : !stroops
                    ? 'Enter an amount'
                    : `Send ${amount} XLM privately`}
        </button>

        <Receipt
          confirmedHash={confirmedHash}
          confirmed={status?.startsWith('Transfer confirmed')}
          confirmedLabel="Transfer confirmed"
          latestLabel="Latest transfer transaction"
          status={status}
          isError={isError}
        />
      </form>
    </section>
  );
}
