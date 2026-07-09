import { useState } from 'react';

import Button from '../components/common/Button';
import Card from '../components/common/Card';
import { clearNotes } from '../lib/storage';
import { usePoolStore } from '../store/pool';
import { useWalletStore } from '../store/wallet';

export default function Settings() {
  const [message, setMessage] = useState<string | null>(null);
  const { address, keys, network } = useWalletStore();
  const { fetchState } = usePoolStore();

  const handleClearLocalNotes = async () => {
    if (!keys) {
      setMessage('Connect and unlock shielded keys before clearing local note storage.');
      return;
    }

    await clearNotes(keys.viewingKey);
    await fetchState();
    setMessage('Local notes and local activity were cleared for this viewing key.');
  };

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Settings</h1>
          <p className="dapp-page-subtitle">
            Manage wallet authorization, connected network state, and shielded data for this device.
          </p>
        </div>
      </header>

      <div className="dapp-grid dapp-grid--settings">
        <Card>
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Network</h2>
              <p className="dapp-card__description">Current network for wallet-authorized settlement activity.</p>
            </div>
            <span className="dapp-badge">{network}</span>
          </div>
          <p className="dapp-status">
            Network selection follows the connected wallet and deployment configuration.
          </p>
        </Card>

        <Card>
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Local shielded data</h2>
              <p className="dapp-card__description">
                Notes are stored per viewing key in this browser. Clearing them can remove spendable
                local state.
              </p>
            </div>
          </div>
          <div className="dapp-setting-list">
            <div className="dapp-setting-row">
              <div>
                <strong>{address ? 'Connected wallet' : 'No wallet connected'}</strong>
                <p className="dapp-helper">
                  {keys ? 'Shielded keys are unlocked for this session.' : 'Shielded keys are not unlocked.'}
                </p>
              </div>
              <Button variant="ghost" type="button" onClick={handleClearLocalNotes}>
                Clear local notes
              </Button>
            </div>
          </div>
          {message && <p className="dapp-status">{message}</p>}
        </Card>
      </div>
    </div>
  );
}
