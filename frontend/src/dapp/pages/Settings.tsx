import React, { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';

export default function Settings() {
  const container = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    gsap.from('.stagger-item', {
      y: 20,
      opacity: 0,
      duration: 0.5,
      stagger: 0.1,
      ease: 'power2.out',
    });
  }, { scope: container });

  return (
    <div ref={container}>
      <div className="page-header stagger-item">
        <h1 className="text-h2 page-title">Settings</h1>
        <p className="text-body text-muted">Manage your wallet and local proofs.</p>
      </div>

      <div className="card stagger-item" style={{ maxWidth: '600px', marginBottom: '2rem' }}>
        <h3 className="text-h3" style={{ marginBottom: '1rem' }}>Network</h3>
        <div className="form-group">
          <label className="form-label">Current Network</label>
          <select className="form-input" defaultValue="testnet">
            <option value="testnet">Stellar Testnet</option>
            <option value="mainnet">Stellar Mainnet</option>
          </select>
        </div>
      </div>

      <div className="card stagger-item" style={{ maxWidth: '600px' }}>
        <h3 className="text-h3" style={{ marginBottom: '1rem' }}>Viewing Keys</h3>
        <p className="text-small text-muted" style={{ marginBottom: '1rem' }}>
          Your viewing keys allow third parties to decrypt your shielded notes without giving them the ability to spend.
        </p>
        <button className="btn btn--ghost">
          Export Viewing Key
        </button>
      </div>
    </div>
  );
}
