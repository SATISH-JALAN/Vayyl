import React, { useState } from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import { usePositionsStore } from '../../store/positions';
import { useToastStore } from '../../store/toast';

export default function ClosePositionForm() {
  const [positionId, setPositionId] = useState('');
  const { positions, closePosition, isProving } = usePositionsStore();
  const { addToast } = useToastStore();

  const handleClose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!positionId) return;
    
    addToast('Generating ZK proof for position close...', 'info');
    try {
      await closePosition(positionId);
      addToast('Position closed successfully!', 'success');
      setPositionId('');
    } catch (e: any) {
      addToast(e.message || 'Failed to close position', 'error');
    }
  };

  return (
    <Card>
      <form onSubmit={handleClose}>
        <div style={{ marginBottom: '24px' }}>
          <h3 className="text-h3" style={{ marginBottom: '8px' }}>Close Position</h3>
          <p className="text-body" style={{ color: 'var(--text-muted)' }}>Close an active position to return collateral.</p>
        </div>
        
        <div style={{ marginBottom: '1rem' }}>
          <label className="text-caption" style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>Select Position</label>
          <select 
            className="input" 
            style={{ width: '100%' }}
            value={positionId}
            onChange={(e) => setPositionId(e.target.value)}
          >
            <option value="">Select a position...</option>
            {positions.map(p => (
              <option key={p.id} value={p.id}>{p.asset} - {p.type} {p.leverage} ({p.size})</option>
            ))}
          </select>
        </div>
        
        <Button type="submit" variant="ghost" style={{ width: '100%', marginTop: '16px', borderColor: 'var(--color-border)' }} disabled={isProving || !positionId}>
          {isProving ? 'Generating Proof...' : 'Close Position'}
        </Button>
      </form>
    </Card>
  );
}
