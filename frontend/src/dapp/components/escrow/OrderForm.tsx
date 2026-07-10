import { useState } from 'react';
import Card from '../common/Card';
import { useEscrowStore } from '../../store/escrow';

export default function OrderForm() {
  const [escrowAmount, setEscrowAmount] = useState('');
  const [triggerPrice, setTriggerPrice] = useState('');
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  
  const { commitOrder, isProving } = useEscrowStore();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!escrowAmount || !triggerPrice) return;
    void commitOrder(escrowAmount, triggerPrice, direction);
  };

  return (
    <Card className="dapp-card--strong">
      <div className="dapp-card__header">
        <div>
          <h2 className="dapp-card__title">Create hidden order</h2>
          <p className="dapp-card__description">
            Lock collateral with a shielded trigger price. The exact execution threshold remains private until triggered.
          </p>
        </div>
      </div>

      <form className="dapp-form" onSubmit={handleSubmit}>
        <div className="dapp-form__group">
          <label>Escrow amount (XLM)</label>
          <div className="dapp-input-wrapper">
            <input
              type="number"
              placeholder="0.0"
              value={escrowAmount}
              onChange={(e) => setEscrowAmount(e.target.value)}
              disabled={isProving}
              min="1"
              required
            />
            <span className="dapp-input-suffix">XLM</span>
          </div>
        </div>

        <div className="dapp-form__group">
          <label>Trigger price</label>
          <div className="dapp-input-wrapper">
            <input
              type="number"
              placeholder="1500"
              value={triggerPrice}
              onChange={(e) => setTriggerPrice(e.target.value)}
              disabled={isProving}
              min="1"
              required
            />
          </div>
        </div>

        <div className="dapp-form__group">
          <label>Trigger condition</label>
          <div className="dapp-direction-toggle">
            <button
              type="button"
              className={`dapp-button ${direction === 'LONG' ? 'dapp-button--primary' : 'dapp-button--outline'}`}
              onClick={() => setDirection('LONG')}
              disabled={isProving}
            >
              Price &ge; Trigger
            </button>
            <button
              type="button"
              className={`dapp-button ${direction === 'SHORT' ? 'dapp-button--danger' : 'dapp-button--outline'}`}
              onClick={() => setDirection('SHORT')}
              disabled={isProving}
            >
              Price &le; Trigger
            </button>
          </div>
        </div>

        <button 
          type="submit" 
          className="dapp-button dapp-button--primary dapp-button--full"
          disabled={isProving || !escrowAmount || !triggerPrice}
        >
          {isProving ? 'Committing...' : 'Commit hidden order'}
        </button>
      </form>
    </Card>
  );
}
