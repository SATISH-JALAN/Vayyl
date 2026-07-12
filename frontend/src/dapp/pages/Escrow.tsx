import Card from '../components/common/Card';

const settlements = [
  { id: '0x19c4…a82f', type: 'Hidden order', condition: 'XLM ≥ $0.1500', value: '2.00 XLM', destination: 'Private balance', state: 'Watching' },
  { id: '0x72ad…11e9', type: 'Scheduled payout', condition: '18 Jul · 14:00 UTC', value: '1.50 XLM', destination: 'Shielded recipient', state: 'Proof ready' },
];

export default function Escrow() {
  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Settlements</h1>
          <p className="dapp-page-subtitle">Reserve private value and release it when a proof-bound condition is satisfied.</p>
        </div>
        <span className="dapp-badge dapp-badge--muted">Product preview</span>
      </header>

      <div className="dapp-preview-notice" role="note">
        <span>Illustrative data</span>
        <p>This interface shows the planned settlement workflow. Conditions and payouts are not active.</p>
      </div>

      <div className="dapp-summary-strip" aria-label="Example settlement summary">
        <div><span>Reserved privately</span><strong>3.50 XLM</strong></div>
        <div><span>Active conditions</span><strong>2</strong></div>
        <div><span>Ready to settle</span><strong>1</strong></div>
        <div><span>Completed</span><strong>12</strong></div>
      </div>

      <div className="dapp-grid dapp-grid--positions">
        <Card className="dapp-card--strong">
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Create a settlement</h2>
              <p className="dapp-card__description">Commit the condition now; disclose only what execution requires.</p>
            </div>
          </div>

          <div className="dapp-form" aria-disabled="true">
            <label className="dapp-form-group">
              <span className="dapp-label">Settlement type</span>
              <select className="dapp-select" value="Hidden order" disabled><option>Hidden order</option></select>
            </label>
            <div className="dapp-form-row">
              <label className="dapp-form-group">
                <span className="dapp-label">Reserved value</span>
                <input className="dapp-input" value="2.00" readOnly disabled />
              </label>
              <label className="dapp-form-group">
                <span className="dapp-label">Asset</span>
                <input className="dapp-input" value="XLM" readOnly disabled />
              </label>
            </div>
            <label className="dapp-form-group">
              <span className="dapp-label">Execute when</span>
              <input className="dapp-input" value="XLM mark price ≥ $0.1500" readOnly disabled />
            </label>
            <label className="dapp-form-group">
              <span className="dapp-label">Settlement destination</span>
              <select className="dapp-select" value="Return to private balance" disabled><option>Return to private balance</option></select>
            </label>
            <div className="dapp-position-summary">
              <div className="dapp-position-summary__row"><span>Condition visibility</span><strong>Committed</strong></div>
              <div className="dapp-position-summary__row"><span>Execution</span><strong>Keeper + trigger proof</strong></div>
              <div className="dapp-position-summary__row"><span>Payout</span><strong>Private note</strong></div>
            </div>
            <button className="dapp-button dapp-button--primary" type="button" disabled>Review settlement</button>
          </div>
        </Card>

        <Card>
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Settlement queue</h2>
              <p className="dapp-card__description">Example commitments waiting for execution.</p>
            </div>
            <span className="dapp-badge">2 active</span>
          </div>

          <div className="dapp-settlement-list">
            {settlements.map((settlement) => (
              <article className="dapp-settlement" key={settlement.id}>
                <header>
                  <div><strong>{settlement.type}</strong><code>{settlement.id}</code></div>
                  <span className={`dapp-badge ${settlement.state === 'Proof ready' ? 'dapp-badge--success' : 'dapp-badge--muted'}`}>{settlement.state}</span>
                </header>
                <dl>
                  <div><dt>Condition</dt><dd>{settlement.condition}</dd></div>
                  <div><dt>Reserved</dt><dd>{settlement.value}</dd></div>
                  <div><dt>Destination</dt><dd>{settlement.destination}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
