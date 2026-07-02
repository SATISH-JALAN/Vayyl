import React, { useState } from 'react';
import DepositForm from '../components/pool/DepositForm';
import WithdrawForm from '../components/pool/WithdrawForm';
import TransferForm from '../components/pool/TransferForm';

export default function Pool() {
  const [activeTab, setActiveTab] = useState<'deposit' | 'withdraw' | 'transfer'>('deposit');

  return (
    <div>
      <header className="dapp-page-header">
        <h1 className="dapp-page-title">Shielded Pool</h1>
        <p className="dapp-page-subtitle">Move assets into and out of the Vayyl confidential settlement layer, or transfer them privately.</p>
      </header>

      <div style={{ maxWidth: '600px' }}>
        <div className="dapp-tabs">
          <button 
            className={`dapp-tab ${activeTab === 'deposit' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('deposit')}
          >
            Shield (Deposit)
          </button>
          <button 
            className={`dapp-tab ${activeTab === 'transfer' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('transfer')}
          >
            Transfer (Send)
          </button>
          <button 
            className={`dapp-tab ${activeTab === 'withdraw' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('withdraw')}
          >
            Unshield (Withdraw)
          </button>
        </div>

        <div>
          {activeTab === 'deposit' && <DepositForm />}
          {activeTab === 'transfer' && <TransferForm />}
          {activeTab === 'withdraw' && <WithdrawForm />}
        </div>
      </div>
    </div>
  );
}
