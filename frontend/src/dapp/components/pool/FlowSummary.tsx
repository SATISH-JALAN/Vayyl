'use client';

import InfoPopover from '../common/InfoPopover';

export type FlowMode = 'deposit' | 'transfer' | 'withdraw';

interface Flow {
  /** What the reader is about to do, in the panel head. */
  title: string;
  rows: Array<{ term: string; value: string; tone?: 'ok' | 'warn' }>;
  note: string;
}

/**
 * What each action actually puts on the ledger.
 *
 * Every row is a fact about the code path that is about to run -- the circuit
 * is the wasm/zkey this build loads, the on-chain effect is what the pool
 * contract writes -- not a marketing claim. The point is that the difference
 * between the three modes is a PRIVACY difference, and a user should be able to
 * read it before committing rather than infer it from three verbs.
 *
 * Shielding is the one that most often surprises people: it is a public
 * transfer, and saying so here is the whole reason this panel exists.
 */
const FLOWS: Record<FlowMode, Flow> = {
  deposit: {
    title: 'Shielding',
    rows: [
      { term: 'On the ledger', value: 'A public transfer', tone: 'warn' },
      { term: 'Also written', value: 'One note commitment' },
      { term: 'Circuit', value: 'deposit_v3' },
      { term: 'Hash', value: 'Poseidon2' },
      { term: 'Verifier', value: 'Native Soroban BN254' },
    ],
    note:
      'A deposit is public: anyone can see this account funded the pool, and for how much. ' +
      'Privacy begins at the next step — what you do with the note is what nobody can follow.',
  },
  transfer: {
    title: 'Sending privately',
    rows: [
      { term: 'On the ledger', value: 'Nullifiers and commitments only', tone: 'ok' },
      { term: 'Amount visible', value: 'No', tone: 'ok' },
      { term: 'Sender or recipient visible', value: 'No', tone: 'ok' },
      { term: 'Notes spent', value: 'Up to two' },
      { term: 'Circuit', value: 'transfer_v3' },
      { term: 'Verifier', value: 'Native Soroban BN254' },
    ],
    note:
      'Nothing leaves the pool. The recipient discovers the payment by scanning with their own ' +
      'viewing key, so you do not have to send them anything out of band.',
  },
  withdraw: {
    title: 'Unshielding',
    rows: [
      { term: 'On the ledger', value: 'A public payment to the destination', tone: 'warn' },
      { term: 'Linked to your deposit', value: 'No — the proof hides which note', tone: 'ok' },
      { term: 'Spends', value: 'One whole note' },
      { term: 'Circuit', value: 'withdraw_v3' },
      { term: 'Verifier', value: 'Native Soroban BN254' },
    ],
    note:
      'The destination and the amount are public, but the link back to the deposit is not: the ' +
      'proof shows the note was in the tree without saying which one. Your crowd is the anonymity set.',
  },
};

export default function FlowSummary({ mode }: { mode: FlowMode }) {
  const flow = FLOWS[mode];

  return (
    <div className="vy-summary">
      <div className="vy-summary__head">
        <span>{flow.title}</span>
        <InfoPopover label="What this action puts on the ledger" align="right">
          <strong>Every row here describes the transaction you are about to send</strong>, not the
          protocol in general. Shielding and unshielding both touch the public ledger — that is
          unavoidable, because value has to enter and leave. The private step is the one in
          between, and it is the only one where amounts and parties are hidden.
        </InfoPopover>
      </div>

      <dl>
        {flow.rows.map((row) => (
          <div key={row.term}>
            <dt>{row.term}</dt>
            <dd className={row.tone ? `is-${row.tone}` : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>

      <p className="vy-note">{flow.note}</p>
    </div>
  );
}
