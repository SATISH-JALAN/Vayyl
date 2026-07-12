import Card from '../components/common/Card';

export default function Positions() {
  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Positions</h1>
          <p className="dapp-page-subtitle">Private collateral and position management.</p>
        </div>
        <span className="dapp-badge dapp-badge--muted">Preview</span>
      </header>
      <Card className="dapp-card--strong">
        <div className="dapp-card__header">
          <div><h2 className="dapp-card__title">Position workspace</h2><p className="dapp-card__description">Open and manage private positions from vault collateral.</p></div>
        </div>
        <div className="dapp-roadmap-list">
          <div className="dapp-roadmap-item"><strong>Vault collateral</strong><span className="dapp-badge dapp-badge--success">Ready</span></div>
          <div className="dapp-roadmap-item"><strong>Private position</strong><span className="dapp-badge dapp-badge--muted">Preview</span></div>
          <div className="dapp-roadmap-item"><strong>Settlement</strong><span className="dapp-badge dapp-badge--muted">Preview</span></div>
        </div>
      </Card>
    </div>
  );
}
