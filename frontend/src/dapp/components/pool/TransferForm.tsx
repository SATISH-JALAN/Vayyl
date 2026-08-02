import { useMemo, useState, type FormEvent } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePoolStore } from '../../store/pool';
import { useWalletStore } from '../../store/wallet';
import { decodeShieldedAddress } from '../../lib/address';

export default function TransferForm() {
  const [recipient, setRecipient] = useState('');
  const { transfer, isProving, shieldedBalance, notes, activity, status } = usePoolStore();
  const { address } = useWalletStore();

  const isError = !!status && /failed|error/i.test(status);
  const activeNotes = notes.filter((note) => !note.isSpent);

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
    if (!recipientValid) return;

    try {
      await transfer(recipient.trim());
      setRecipient('');
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
            Move one note to another Vayyl address. Nothing leaves the pool, and
            neither party appears on the ledger.
          </p>
        </div>
        <span className="dapp-badge dapp-badge--warning">Whole note</span>
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
          value="1 XLM"
          disabled
          readOnly
          helperText={`${shieldedBalance} XLM available across ${activeNotes.length} active fixed note${activeNotes.length === 1 ? '' : 's'}.`}
        />

        <Button type="submit" disabled={isProving || !recipientValid || !address || activeNotes.length === 0}>
          {!address
            ? 'Connect wallet first'
            : activeNotes.length === 0
              ? 'No spendable note'
              : isProving
                ? 'Generating proof'
                : 'Send 1 XLM privately'}
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
