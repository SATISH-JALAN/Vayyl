'use client';

import Button from './Button';
import { useWalletStore } from '../../store/wallet';
import { usePoolStore } from '../../store/pool';
import { usePositionsStore } from '../../store/positions';

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Connect / unlock / disconnect.
 *
 * Extracted from `App.tsx` because the positions terminal puts the wallet
 * button in its own market bar rather than the shell's topbar -- the design has
 * one row carrying both, and two copies of this logic would drift.
 *
 * Unlocking is a separate step from connecting on purpose: connecting exposes
 * only a public address, while unlocking derives the viewing key that decrypts
 * every note. Collapsing them would derive key material the moment a wallet is
 * attached, whether or not the user meant to open their balance.
 */
export default function WalletControls({ compact = false }: { compact?: boolean }) {
  const { address, keys, isConnecting, isUnlocking, connect, disconnect, unlockShieldedKeys } =
    useWalletStore();

  const handleUnlock = async () => {
    try {
      await unlockShieldedKeys();
      // Both verticals read the same shielded notes, so both refresh once the
      // key exists. Neither can do anything useful before that.
      usePoolStore.getState().fetchState();
      usePositionsStore.getState().fetchState();
    } catch (e) {
      console.error('Failed to unlock keys:', e);
    }
  };

  if (!address) {
    return (
      <div className="dapp-wallet">
        <Button onClick={connect} disabled={isConnecting || isUnlocking}>
          {isConnecting ? 'Connecting' : 'Connect wallet'}
        </Button>
      </div>
    );
  }

  return (
    <div className="dapp-wallet">
      {!compact && (
        <div className="dapp-wallet__identity">
          <span className="dapp-label-text">
            <i aria-hidden="true" /> Connected
          </span>
          <strong>{shortAddress(address)}</strong>
        </div>
      )}
      {!keys && (
        <Button onClick={handleUnlock} disabled={isUnlocking}>
          {isUnlocking ? 'Unlocking...' : 'Unlock'}
        </Button>
      )}
      <Button variant="ghost" onClick={disconnect}>
        {compact ? shortAddress(address) : 'Disconnect'}
      </Button>
    </div>
  );
}
