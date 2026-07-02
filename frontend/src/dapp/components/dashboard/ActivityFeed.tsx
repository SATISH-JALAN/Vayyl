import React from 'react';
import Card from '../common/Card';

export default function ActivityFeed() {
  const activities = [
    { id: 1, type: 'Deposit', amount: '10000 XLM', time: '2 mins ago', status: 'Confirmed' },
    { id: 2, type: 'Transfer', amount: '500 XLM', time: '1 hr ago', status: 'Confirmed' },
    { id: 3, type: 'Withdraw', amount: '2500 XLM', time: '1 day ago', status: 'Confirmed' },
  ];

  return (
    <Card>
      <h3 className="text-h3" style={{ marginBottom: '16px' }}>Recent Shielded Activity</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {activities.map(act => (
          <div key={act.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '12px', borderBottom: '1px solid var(--color-border)' }}>
            <div>
              <div className="text-body" style={{ fontWeight: 600 }}>{act.type}</div>
              <div className="text-caption" style={{ color: 'var(--text-muted)' }}>{act.time}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="text-mono">{act.amount}</div>
              <div className="text-caption" style={{ color: 'var(--success)' }}>{act.status}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
