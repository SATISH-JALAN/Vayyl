import React, { useState } from 'react';
import Card from '../common/Card';
import Input from '../common/Input';
import Button from '../common/Button';
import { usePoolStore } from '../../store/pool';

export default function WithdrawForm() {
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const { withdraw, isProving, shieldedBalance } = usePoolStore();

  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || !destination) return;
    
    try {
      await withdraw(Number(amount), 'XLM', destination);
      setAmount('');
      setDestination('');
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <Card>
      <h3 style={{ fontSize: 'var(--text-h3)', fontFamily: 'var(--font-display)', marginBottom: '1.5rem', color: 'var(--text-primary)' }}>Unshield Assets</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-body)', marginBottom: '2rem' }}>
        Withdraw shielded assets to a public Stellar address. The source of these funds cannot be traced by observers.
      </p>

      <form onSubmit={handleWithdraw}>
        <Input 
          label="Destination Address" 
          placeholder="G..." 
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          disabled={isProving}
        />
        
        <div style={{ marginTop: '1.5rem', marginBottom: '2rem' }}>
          <Input 
            label="Amount (Max: {shieldedBalance} XLM)" 
            type="number" 
            placeholder="0.00" 
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={isProving}
          />
        </div>

        <Button type="submit" disabled={isProving || !amount || !destination} style={{ width: '100%', justifyContent: 'center' }}>
          {isProving ? 'Generating ZK Proof...' : 'Unshield Assets'}
        </Button>
      </form>
    </Card>
  );
}
