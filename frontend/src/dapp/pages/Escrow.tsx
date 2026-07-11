import Card from '../components/common/Card';

export default function Escrow() {
  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Conditional settlement</h1>
          <p className="dapp-page-subtitle">Hidden orders and agent settlements are designed around the same proof-verified pool, but are not activated in Vault v1.</p>
        </div>
        <span className="dapp-badge dapp-badge--warning">Mainnet audit track</span>
      </header>
      <Card className="dapp-card--strong">
        <div className="dapp-card__header">
          <div><h2 className="dapp-card__title">Proof-bound recipients before activation</h2><p className="dapp-card__description">Order and quest payouts stay disabled until recipient and payout metadata are fully constrained by their proofs.</p></div>
        </div>
        <div className="dapp-roadmap-list">
          <div className="dapp-roadmap-item"><strong>Hidden trigger</strong><span className="dapp-badge dapp-badge--warning">Binding review</span></div>
          <div className="dapp-roadmap-item"><strong>Agent settlement</strong><span className="dapp-badge dapp-badge--warning">Binding review</span></div>
          <div className="dapp-roadmap-item"><strong>Public payout</strong><span className="dapp-badge dapp-badge--muted">Disabled</span></div>
        </div>
      </Card>
    </div>
  );
}
