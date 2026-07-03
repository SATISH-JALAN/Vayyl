import React, { useState } from 'react';
import Card from '../common/Card';
import Input from '../common/Input';
import Button from '../common/Button';
import { usePoolStore } from '../../store/pool';

export default function DepositForm() {
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState('XLM');
  const { deposit, isProving, status } = usePoolStore();

  const handleDeposit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount) return;

    try {
      await deposit(Number(amount), asset);
      setAmount('');
    } catch (e) {
      // The store already sets a human-readable `status`; surface it below and
      // keep the full error in the console for debugging.
      console.error(e);
    }
  };

  const isError = !!status && /failed|error/i.test(status);

  return (
    <Card>
      <h3 style={{ fontSize: 'var(--text-h3)', fontFamily: 'var(--font-display)', marginBottom: '1.5rem', color: 'var(--text-primary)' }}>Shield Assets</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-body)', marginBottom: '2rem' }}>
        Deposit assets into the pool to create a shielded note. This breaks the link between your public address and future transactions.
      </p>

      <form onSubmit={handleDeposit}>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
          <div style={{ flex: 1 }}>
            <Input 
              label="Amount" 
              type="number" 
              placeholder="0.00" 
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={isProving}
            />
          </div>
          <div style={{ width: '120px' }}>
            <Input 
              label="Asset" 
              value={asset}
              disabled
            />
          </div>
        </div>

        <Button type="submit" disabled={isProving || !amount} style={{ width: '100%', justifyContent: 'center' }}>
          {isProving ? 'Generating ZK Proof...' : 'Shield Assets'}
        </Button>

        {status && (
          <p
            style={{
              marginTop: '1rem',
              fontSize: 'var(--text-small, 0.85rem)',
              wordBreak: 'break-word',
              color: isError ? 'var(--error, #ff6b6b)' : 'var(--text-muted)',
            }}
          >
            {status}
          </p>
        )}
      </form>
    </Card>
  );
}
