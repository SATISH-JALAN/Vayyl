import { useEffect, useState } from 'react';
import Card from '../components/common/Card';
import { useWalletStore } from '../store/wallet';
import { useEscrowStore } from '../store/escrow';
import OrderForm from '../components/escrow/OrderForm';
import QuestForm from '../components/escrow/QuestForm';
import OrderCard from '../components/escrow/OrderCard';
import QuestCard from '../components/escrow/QuestCard';

export default function Escrow() {
  const { address, keys } = useWalletStore();
  const { orders, quests, fetchState, status } = useEscrowStore();
  
  // Tab state: 'orders' | 'quests'
  const [activeTab, setActiveTab] = useState<'orders' | 'quests'>('orders');

  useEffect(() => {
    if (address && keys) {
      void fetchState();
    }
  }, [address, keys, fetchState]);

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Escrow & Settlement</h1>
          <p className="dapp-page-subtitle">
            Create conditional smart escrows. Hidden Orders trigger privately based on oracle price. 
            Agentic Quests settle permissionlessly via ZK proofs of computation.
          </p>
        </div>
      </header>

      {!address ? (
        <Card className="dapp-card--strong">
          <div className="dapp-empty">
            <strong>Wallet required</strong>
            <p>Connect Freighter to manage conditional escrow positions.</p>
          </div>
        </Card>
      ) : (
        <div className="dapp-stack">
          {/* Tab Navigation */}
          <div className="dapp-tabs" style={{ display: 'flex', gap: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
            <button 
              className={`dapp-button ${activeTab === 'orders' ? 'dapp-button--primary' : 'dapp-button--outline'}`}
              onClick={() => setActiveTab('orders')}
            >
              Hidden Orders
            </button>
            <button 
              className={`dapp-button ${activeTab === 'quests' ? 'dapp-button--primary' : 'dapp-button--outline'}`}
              onClick={() => setActiveTab('quests')}
            >
              Agentic Quests
            </button>
          </div>

          <div className="dapp-grid dapp-grid--positions">
            {/* Left: Create Form */}
            {activeTab === 'orders' ? <OrderForm /> : <QuestForm />}

            {/* Right: List */}
            <div className="dapp-stack">
              <Card>
                <div className="dapp-card__header">
                  <div>
                    <h2 className="dapp-card__title">
                      {activeTab === 'orders' ? 'Active Orders' : 'Active Quests'}
                    </h2>
                    <p className="dapp-card__description">
                      Your current escrowed {activeTab}.
                    </p>
                  </div>
                </div>

                {activeTab === 'orders' ? (
                  orders.length === 0 ? (
                    <div className="dapp-empty">
                      <strong>No hidden orders</strong>
                      <p>Create a hidden order to set a private stop-loss or take-profit trigger.</p>
                    </div>
                  ) : (
                    <div className="dapp-position-list">
                      {orders.map(o => <OrderCard key={o.order_id} order={o} />)}
                    </div>
                  )
                ) : (
                  quests.length === 0 ? (
                    <div className="dapp-empty">
                      <strong>No agentic quests</strong>
                      <p>Create a quest to bounty an automated task to the agent network.</p>
                    </div>
                  ) : (
                    <div className="dapp-position-list">
                      {quests.map(q => <QuestCard key={q.quest_id} quest={q} />)}
                    </div>
                  )
                )}
              </Card>

              {/* Transaction status */}
              {status && (
                <Card>
                  <div className="dapp-card__header">
                    <div>
                      <h2 className="dapp-card__title">Transaction status</h2>
                      <p className="dapp-card__description">Current proof generation and network state.</p>
                    </div>
                  </div>
                  <p className={`dapp-status ${status.toLowerCase().includes('failed') ? 'dapp-status--error' : ''}`}>
                    {status}
                  </p>
                </Card>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
