import Card from '../components/common/Card';
import { useWalletStore } from '../store/wallet';

const positionRows = [
  {
    title: 'Collateral',
    value: '0 XLM',
  },
  {
    title: 'Exposure',
    value: '0.00',
  },
  {
    title: 'Open PnL',
    value: '0.00 XLM',
  },
];

export default function Positions() {
  const { address } = useWalletStore();

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Positions</h1>
          <p className="dapp-page-subtitle">
            Review private position exposure tied to the connected shielded identity.
          </p>
        </div>
      </header>

      <div className="dapp-grid dapp-grid--overview">
        <Card className="dapp-card--strong">
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Private positions</h2>
              <p className="dapp-card__description">
                Position state appears after connecting a wallet with active shielded exposure.
              </p>
            </div>
            <span className="dapp-badge dapp-badge--muted">{address ? 'Connected' : 'Locked'}</span>
          </div>

          <div className="dapp-empty">
            <strong>{address ? 'No active positions' : 'Wallet required'}</strong>
            <p>
              {address
                ? 'Open positions associated with this shielded identity will appear here.'
                : 'Connect Freighter to view private position state.'}
            </p>
          </div>
        </Card>

        <Card>
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Position summary</h2>
              <p className="dapp-card__description">Current exposure for the connected account.</p>
            </div>
          </div>

          <div className="dapp-setting-list">
            {positionRows.map((row) => (
              <div className="dapp-setting-row" key={row.title}>
                <strong>{row.title}</strong>
                <span className="dapp-mono">{row.value}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
