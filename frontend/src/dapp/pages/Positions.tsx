import React from 'react';
import Card from '../components/common/Card';
import OpenPositionForm from '../components/positions/OpenPositionForm';
import ClosePositionForm from '../components/positions/ClosePositionForm';
import { usePositionsStore } from '../store/positions';

export default function Positions() {
  const { positions } = usePositionsStore();

  return (
    <div>
      <header className="dapp-page-header">
        <h1 className="dapp-page-title">Private Positions</h1>
        <p className="dapp-page-subtitle">Manage your leveraged positions. Liquidation boundaries are proven continuously via zero-knowledge heartbeats.</p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 350px', gap: '2rem', alignItems: 'start' }}>
        {/* Left Column: Active Positions */}
        <div>
          <h2 className="text-h3" style={{ marginBottom: '1.5rem' }}>Active Positions</h2>
          {positions.length === 0 ? (
            <p className="text-body" style={{ color: 'var(--text-muted)' }}>No active positions.</p>
          ) : (
            <div style={{ display: 'grid', gap: '1.5rem' }}>
              {positions.map(pos => (
                <Card key={pos.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: 'var(--text-h3)', fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>{pos.asset}</span>
                      <span style={{ 
                        fontSize: '11px', 
                        textTransform: 'uppercase', 
                        letterSpacing: '0.1em',
                        padding: '2px 8px',
                        borderRadius: '12px',
                        border: `1px solid ${pos.type === 'Long' ? 'var(--success)' : 'var(--error)'}`,
                        color: pos.type === 'Long' ? 'var(--success)' : 'var(--error)'
                      }}>
                        {pos.type} {pos.leverage}
                      </span>
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-small)' }}>
                      Position Size: <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{pos.size}</span>
                    </div>
                  </div>

                  <div style={{ textAlign: 'right' }}>
                    <div style={{ marginBottom: '0.5rem', color: 'var(--text-muted)', fontSize: 'var(--text-small)' }}>
                      Health Factor
                    </div>
                    <div style={{ color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: '1.25rem' }}>
                      {pos.health}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Right Column: Forms */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <OpenPositionForm />
          <ClosePositionForm />
        </div>
      </div>
    </div>
  );
}
