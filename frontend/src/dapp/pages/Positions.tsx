import Card from '../components/common/Card';

const positions = [
  {
    market: 'XLM / USD',
    side: 'Long',
    leverage: '3×',
    size: '12.00 XLM',
    collateral: '4.00 XLM',
    entry: '$0.1082',
    mark: '$0.1121',
    pnl: '+0.14 XLM',
    liquidation: '$0.0764',
    health: '82%',
    healthValue: 82,
  },
];

export default function Positions() {
  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Positions</h1>
          <p className="dapp-page-subtitle">Commit collateral and prove position health without publishing the full position.</p>
        </div>
        <span className="dapp-badge dapp-badge--muted">Product preview</span>
      </header>

      <div className="dapp-preview-notice" role="note">
        <span>Illustrative data</span>
        <p>This interface shows the planned position workflow. Position actions are not active.</p>
      </div>

      <div className="dapp-summary-strip" aria-label="Example private portfolio summary">
        <div><span>Private collateral</span><strong>4.00 XLM</strong></div>
        <div><span>Net exposure</span><strong>12.00 XLM</strong></div>
        <div><span>Unrealized PnL</span><strong className="is-positive">+0.14 XLM</strong></div>
        <div><span>Margin health</span><strong>82%</strong></div>
      </div>

      <div className="dapp-grid dapp-grid--positions">
        <Card className="dapp-card--strong">
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Open a private position</h2>
              <p className="dapp-card__description">Values become inputs to a local position proof.</p>
            </div>
          </div>

          <div className="dapp-form" aria-disabled="true">
            <label className="dapp-form-group">
              <span className="dapp-label">Market</span>
              <select className="dapp-select" value="XLM / USD" disabled><option>XLM / USD</option></select>
            </label>
            <div className="dapp-direction-toggle" aria-label="Position direction">
              <button type="button" className="dapp-direction-toggle__button dapp-direction-toggle__button--long is-active" disabled>Long</button>
              <button type="button" className="dapp-direction-toggle__button dapp-direction-toggle__button--short" disabled>Short</button>
            </div>
            <div className="dapp-form-row">
              <label className="dapp-form-group">
                <span className="dapp-label">Collateral</span>
                <input className="dapp-input" value="1.00" readOnly disabled />
              </label>
              <label className="dapp-form-group">
                <span className="dapp-label">Asset</span>
                <input className="dapp-input" value="XLM" readOnly disabled />
              </label>
            </div>
            <div className="dapp-leverage-group" aria-label="Leverage">
              {['1×', '2×', '3×', '5×'].map((value) => (
                <button key={value} type="button" className={`dapp-leverage-chip ${value === '3×' ? 'is-active' : ''}`} disabled>{value}</button>
              ))}
            </div>
            <div className="dapp-position-summary">
              <div className="dapp-position-summary__row"><span>Estimated exposure</span><strong>3.00 XLM</strong></div>
              <div className="dapp-position-summary__row"><span>Margin mode</span><strong>Isolated</strong></div>
              <div className="dapp-position-summary__row"><span>Proof output</span><strong>Position commitment</strong></div>
            </div>
            <button className="dapp-button dapp-button--primary" type="button" disabled>Review position</button>
          </div>
        </Card>

        <Card>
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Private positions</h2>
              <p className="dapp-card__description">Only proof-bound state is intended to reach the ledger.</p>
            </div>
            <span className="dapp-badge dapp-badge--success">1 active</span>
          </div>

          <div className="dapp-position-list">
            {positions.map((position) => (
              <article className="dapp-position-card" key={position.market}>
                <header className="dapp-position-card__header">
                  <div className="dapp-position-card__meta">
                    <strong>{position.market}</strong>
                    <span className="dapp-direction-badge dapp-direction-badge--long">{position.side} {position.leverage}</span>
                  </div>
                  <strong className="dapp-value-positive">{position.pnl}</strong>
                </header>
                <div className="dapp-position-card__body">
                  <div className="dapp-position-card__stat"><span>Size</span><strong>{position.size}</strong></div>
                  <div className="dapp-position-card__stat"><span>Collateral</span><strong>{position.collateral}</strong></div>
                  <div className="dapp-position-card__stat"><span>Health</span><strong>{position.health}</strong></div>
                  <div className="dapp-position-card__stat"><span>Entry</span><strong>{position.entry}</strong></div>
                  <div className="dapp-position-card__stat"><span>Mark</span><strong>{position.mark}</strong></div>
                  <div className="dapp-position-card__stat"><span>Liquidation</span><strong>{position.liquidation}</strong></div>
                </div>
                <progress className="dapp-health-track" aria-label={`Example margin health ${position.health}`} value={position.healthValue} max="100" />
              </article>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
