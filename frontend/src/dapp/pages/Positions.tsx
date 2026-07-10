import { useEffect } from 'react';

import Card from '../components/common/Card';
import OpenPositionForm from '../components/positions/OpenPositionForm';
import PositionCard from '../components/positions/PositionCard';
import { usePositionsStore } from '../store/positions';
import { useWalletStore } from '../store/wallet';
import { usePoolStore } from '../store/pool';

export default function Positions() {
  const { address, keys } = useWalletStore();
  const { positions, fetchState, status } = usePositionsStore();
  const poolFetch = usePoolStore((s) => s.fetchState);

  useEffect(() => {
    if (address && keys) {
      void fetchState();
      void poolFetch(); // ensure shielded balance is current for the open form
    }
  }, [address, keys, fetchState, poolFetch]);

  const activePositions = positions.filter((p) => p.status === 'Active');
  const closedPositions = positions.filter((p) => p.status === 'Closed');

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Positions</h1>
          <p className="dapp-page-subtitle">
            Open leveraged positions backed by shielded collateral. Proofs are generated
            client-side and verified on-chain by the position-manager contract.
          </p>
        </div>
      </header>

      {!address ? (
        <Card className="dapp-card--strong">
          <div className="dapp-empty">
            <strong>Wallet required</strong>
            <p>Connect Freighter to open and manage private positions.</p>
          </div>
        </Card>
      ) : (
        <div className="dapp-grid dapp-grid--positions">
          {/* Left: open position form */}
          <OpenPositionForm />

          {/* Right: active positions list */}
          <div className="dapp-stack">
            <Card>
              <div className="dapp-card__header">
                <div>
                  <h2 className="dapp-card__title">Active positions</h2>
                  <p className="dapp-card__description">
                    {activePositions.length} active position{activePositions.length === 1 ? '' : 's'} for this shielded identity.
                  </p>
                </div>
                <span className="dapp-badge dapp-badge--muted">Private</span>
              </div>

              {activePositions.length === 0 ? (
                <div className="dapp-empty">
                  <strong>No active positions</strong>
                  <p>
                    Open a position to create leveraged exposure backed by a shielded note.
                  </p>
                </div>
              ) : (
                <div className="dapp-position-list">
                  {activePositions.map((pos) => (
                    <PositionCard key={pos.id} position={pos} />
                  ))}
                </div>
              )}
            </Card>

            {/* Closed positions (collapsed view) */}
            {closedPositions.length > 0 && (
              <Card>
                <div className="dapp-card__header">
                  <div>
                    <h2 className="dapp-card__title">Closed positions</h2>
                    <p className="dapp-card__description">
                      {closedPositions.length} previously settled position{closedPositions.length === 1 ? '' : 's'}.
                    </p>
                  </div>
                </div>
                <div className="dapp-position-list">
                  {closedPositions.map((pos) => (
                    <PositionCard key={pos.id} position={pos} />
                  ))}
                </div>
              </Card>
            )}

            {/* Transaction status */}
            {status && (
              <Card>
                <div className="dapp-card__header">
                  <div>
                    <h2 className="dapp-card__title">Transaction status</h2>
                    <p className="dapp-card__description">Current proof generation and settlement state.</p>
                  </div>
                </div>
                <p className={`dapp-status ${status.toLowerCase().includes('failed') ? 'dapp-status--error' : ''}`}>
                  {status}
                </p>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
