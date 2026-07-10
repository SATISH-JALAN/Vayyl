import { useState, useEffect } from 'react';

import Button from '../common/Button';
import { usePositionsStore, type Position } from '../../store/positions';
import { useOracleStore } from '../../store/oracle';

function truncateId(id: string): string {
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export default function PositionCard({ position }: { position: Position }) {
  const { closePosition, isProving } = usePositionsStore();
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = async () => {
    setIsClosing(true);
    try {
      await closePosition(position.position_id);
    } catch {
      // error surfaced via toast
    } finally {
      setIsClosing(false);
    }
  };

  const isActive = position.status === 'Active';
  const isLong = position.type === 'Long';

  const { startPolling, stopPolling, prices } = useOracleStore();
  
  useEffect(() => {
    if (isActive) {
      startPolling(position.asset);
      return () => stopPolling(position.asset);
    }
  }, [isActive, position.asset, startPolling, stopPolling]);

  const livePrice = prices[position.asset];
  const entryPrice = position.entry_price ? Number(position.entry_price) : null;
  
  let pnlStr = '--';
  let pnlClass = '';
  if (livePrice && entryPrice) {
    const size = Number(position.size);
    const priceDiff = (livePrice - entryPrice) / 10000;
    const pnl = isLong ? size * priceDiff : size * -priceDiff;
    pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    pnlClass = pnl >= 0 ? '#10b981' : '#ef4444';
  }

  return (
    <div className={`dapp-position-card ${!isActive ? 'dapp-position-card--closed' : ''}`}>
      <div className="dapp-position-card__header">
        <div className="dapp-position-card__meta">
          <span className={`dapp-direction-badge dapp-direction-badge--${isLong ? 'long' : 'short'}`}>
            {position.type}
          </span>
          <span className="dapp-badge dapp-badge--muted">{position.leverage}</span>
        </div>
        <span className={`dapp-badge ${isActive ? 'dapp-badge--success' : ''}`}>
          {position.status}
        </span>
      </div>

      <div className="dapp-position-card__body">
        <div className="dapp-position-card__stat">
          <span className="dapp-label">Size</span>
          <strong className="dapp-mono">{position.size} {position.asset}</strong>
        </div>
        <div className="dapp-position-card__stat">
          <span className="dapp-label">Health</span>
          <strong className="dapp-mono">{position.health}</strong>
        </div>
        <div className="dapp-position-card__stat">
          <span className="dapp-label">Entry</span>
          <strong className="dapp-mono">{entryPrice ? `$${(entryPrice / 10000).toFixed(4)}` : '--'}</strong>
        </div>
        <div className="dapp-position-card__stat">
          <span className="dapp-label">Mark</span>
          <strong className="dapp-mono">{livePrice ? `$${(livePrice / 10000).toFixed(4)}` : '--'}</strong>
        </div>
        <div className="dapp-position-card__stat">
          <span className="dapp-label">PnL</span>
          <strong className="dapp-mono" style={{ color: pnlClass ? pnlClass : undefined }}>
            {pnlStr}
          </strong>
        </div>
        <div className="dapp-position-card__stat">
          <span className="dapp-label">ID</span>
          <span className="dapp-mono dapp-position-card__id">{truncateId(position.position_id)}</span>
        </div>
      </div>

      {isActive && (
        <div className="dapp-position-card__actions">
          <Button
            variant="ghost"
            onClick={handleClose}
            disabled={isClosing || isProving}
          >
            {isClosing ? 'Closing…' : 'Close position'}
          </Button>
        </div>
      )}
    </div>
  );
}
