import Card from '../common/Card';
import { HiddenOrder, useEscrowStore } from '../../store/escrow';

export default function OrderCard({ order }: { order: HiddenOrder }) {
  const { cancelOrder, isProving } = useEscrowStore();

  const isExecuted = order.status === 'executed';
  const isCancelled = order.status === 'cancelled';
  const isActive = order.status === 'active';

  return (
    <Card className="dapp-position-card">
      <div className="dapp-position-card__header">
        <div>
          <h3 className="dapp-position-card__title">Order #{order.order_id.slice(0, 8)}</h3>
          <p className="dapp-position-card__subtitle">
            Escrowed {order.escrow_amount} XLM
          </p>
        </div>
        <span className={`dapp-badge ${
          isActive ? 'dapp-badge--muted' : 
          isExecuted ? 'dapp-badge--success' : ''
        }`}>
          {order.status.toUpperCase()}
        </span>
      </div>

      <div className="dapp-position-card__stats">
        <div className="dapp-stat">
          <label>Direction</label>
          <span className={`dapp-direction-badge dapp-direction-badge--${order.order_direction.toLowerCase()}`}>
            {order.order_direction}
          </span>
        </div>
        <div className="dapp-stat">
          <label>Trigger Price</label>
          <span>{order.trigger_price}</span>
        </div>
      </div>

      {isActive && (
        <div className="dapp-position-card__actions">
          <button 
            className="dapp-button dapp-button--outline dapp-button--full"
            onClick={() => cancelOrder(order.order_id)}
            disabled={isProving}
          >
            {isProving ? 'Cancelling...' : 'Cancel Order'}
          </button>
        </div>
      )}
    </Card>
  );
}
