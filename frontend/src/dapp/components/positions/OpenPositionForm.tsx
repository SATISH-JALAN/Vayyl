import React, { useState } from 'react';
import Card from '../common/Card';
import Input from '../common/Input';
import Button from '../common/Button';
import { usePositionsStore } from '../../store/positions';
import { useToastStore } from '../../store/toast';

export default function OpenPositionForm() {
  const [asset, setAsset] = useState('USDC/XLM');
  const [type, setType] = useState<'Long' | 'Short'>('Long');
  const [leverage, setLeverage] = useState('5x');
  const [size, setSize] = useState('');
  const { openPosition, isProving } = usePositionsStore();
  const { addToast } = useToastStore();

  const handleOpen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!size) return;
    
    addToast('Generating ZK proof for position open...', 'info');
    try {
      await openPosition(asset, type, leverage, `$${size}`);
      addToast('Position opened successfully!', 'success');
      setSize('');
    } catch (e: any) {
      addToast(e.message || 'Failed to open position', 'error');
    }
  };

  return (
    <Card>
      <form onSubmit={handleOpen}>
        <div style={{ marginBottom: '24px' }}>
          <h3 className="text-h3" style={{ marginBottom: '8px' }}>Open Position</h3>
          <p className="text-body" style={{ color: 'var(--text-muted)' }}>Enter a private leveraged position.</p>
        </div>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label className="text-caption" style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>Asset Pair</label>
              <select 
                className="input" 
                style={{ width: '100%' }}
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
              >
                <option value="USDC/XLM">USDC / XLM</option>
                <option value="BTC/USDC">BTC / USDC</option>
              </select>
            </div>
            <div>
              <label className="text-caption" style={{ display: 'block', marginBottom: '8px', color: 'var(--text-muted)' }}>Direction</label>
              <select 
                className="input" 
                style={{ width: '100%' }}
                value={type}
                onChange={(e) => setType(e.target.value as 'Long' | 'Short')}
              >
                <option value="Long">Long</option>
                <option value="Short">Short</option>
              </select>
            </div>
        </div>

        <Input 
          label="Position Size (USD)" 
          placeholder="0.00" 
          type="number"
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />
        
        <Button type="submit" style={{ width: '100%', marginTop: '16px' }} disabled={isProving || !size}>
          {isProving ? 'Generating Proof...' : 'Open Position'}
        </Button>
      </form>
    </Card>
  );
}
