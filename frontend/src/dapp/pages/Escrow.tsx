import Card from '../components/common/Card';

export default function Escrow() {
  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Settlements</h1>
          <p className="dapp-page-subtitle">Proof-bound orders and automated payouts.</p>
        </div>
        <span className="dapp-badge dapp-badge--muted">Preview</span>
      </header>
      <Card className="dapp-card--strong">
        <div className="dapp-card__header">
          <div><h2 className="dapp-card__title">Settlement workspace</h2><p className="dapp-card__description">Create conditions and settle when their proof is valid.</p></div>
        </div>
        <div className="dapp-roadmap-list">
          <div className="dapp-roadmap-item"><strong>Private condition</strong><span className="dapp-badge dapp-badge--muted">Preview</span></div>
          <div className="dapp-roadmap-item"><strong>Agent settlement</strong><span className="dapp-badge dapp-badge--muted">Preview</span></div>
          <div className="dapp-roadmap-item"><strong>Proof-bound payout</strong><span className="dapp-badge dapp-badge--muted">Preview</span></div>
        </div>
      </Card>
    </div>
  );
}
