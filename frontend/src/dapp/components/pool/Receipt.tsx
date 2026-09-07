'use client';

import { EXPLORER_TX, shortHash } from '../../lib/format';

/**
 * The result line, shared in shape by all three composers.
 *
 * A transaction hash outranks a status string: once something is on-chain, the
 * link to it is the only answer that cannot be wrong. Each composer used to
 * inline its own copy of this, which is why they had drifted into three
 * slightly different confirmations of the same event.
 */
export default function Receipt({
  confirmedHash,
  confirmed,
  confirmedLabel,
  latestLabel,
  status,
  isError,
}: {
  confirmedHash?: string;
  confirmed?: boolean;
  confirmedLabel: string;
  latestLabel: string;
  status: string | null;
  isError: boolean;
}) {
  if (confirmedHash) {
    return (
      <a
        className={`vy-receipt ${confirmed ? 'is-ok' : ''}`.trim()}
        href={`${EXPLORER_TX}/${confirmedHash}`}
        target="_blank"
        rel="noreferrer"
      >
        <span className="vy-receipt__label">{confirmed ? confirmedLabel : latestLabel}</span>
        <span className="vy-receipt__hash dapp-mono">{shortHash(confirmedHash, 10, 8)}</span>
        <img src="/brands/stellar-expert.png" alt="View in Stellar Expert" />
      </a>
    );
  }
  if (!status) return null;
  return (
    <p className={`vy-field-hint ${isError ? 'is-error' : 'is-ok'}`} role="status">
      {status}
    </p>
  );
}
