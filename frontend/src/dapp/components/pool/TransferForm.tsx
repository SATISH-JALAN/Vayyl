import React, { useState } from 'react';
import Card from '../common/Card';
import Input from '../common/Input';
import Button from '../common/Button';
import { usePoolStore } from '../../store/pool';
import { useToastStore } from '../../store/toast';

export default function TransferForm() {
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const { transfer, isProving } = usePoolStore();
  const { addToast } = useToastStore();

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || !recipient) return;
    
    addToast('Generating ZK proof for transfer...', 'info');
    try {
      await transfer(Number(amount), 'XLM', recipient);
      addToast('Transfer successful!', 'success');
      setAmount('');
      setRecipient('');
    } catch (e: any) {
      addToast(e.message || 'Transfer failed', 'error');
    }
  };

  return (
    <Card>
      <form onSubmit={handleTransfer}>
        <div style={{ marginBottom: '24px' }}>
          <h3 className="text-h3" style={{ marginBottom: '8px' }}>Shielded Transfer</h3>
          <p className="text-body" style={{ color: 'var(--text-muted)' }}>Send assets confidentially to another stealth address.</p>
        </div>
        
        <Input 
          label="Recipient Stealth Address" 
          placeholder="v-stealth-..." 
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
        />
        
        <Input 
          label="Amount to Transfer" 
          placeholder="0.00" 
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        
        <Button type="submit" style={{ width: '100%', marginTop: '16px' }} disabled={isProving || !amount || !recipient}>
          {isProving ? 'Generating Proof...' : 'Send Confidentially'}
        </Button>
      </form>
    </Card>
  );
}
