import Card from '../components/common/Card';

export default function Positions() {
  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Private positions</h1>
          <p className="dapp-page-subtitle">Directional positions remain visible as part of the protocol architecture, but are not activated in Vault v1.</p>
        </div>
        <span className="dapp-badge dapp-badge--warning">Mainnet audit track</span>
      </header>
      <Card className="dapp-card--strong">
        <div className="dapp-card__header">
          <div><h2 className="dapp-card__title">Collateral accounting under review</h2><p className="dapp-card__description">Activation requires bounded payout accounting, oracle normalization, and liquidation review.</p></div>
        </div>
        <div className="dapp-roadmap-list">
          <div className="dapp-roadmap-item"><strong>Shielded collateral</strong><span className="dapp-badge dapp-badge--success">Vault primitive live</span></div>
          <div className="dapp-roadmap-item"><strong>Private direction and size</strong><span className="dapp-badge dapp-badge--warning">Circuit review</span></div>
          <div className="dapp-roadmap-item"><strong>PnL settlement</strong><span className="dapp-badge dapp-badge--warning">Economic review</span></div>
        </div>
      </Card>
    </div>
  );
}
