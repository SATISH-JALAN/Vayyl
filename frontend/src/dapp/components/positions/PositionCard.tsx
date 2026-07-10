import { useState } from 'react';

import Button from '../common/Button';
import { usePositionsStore, type Position } from '../../store/positions';

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
