import React from 'react';
import Card from '../common/Card';
import { usePoolStore } from '../../store/pool';

/** "2 mins ago" style relative time from a ms-epoch timestamp. */
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s <= 1 ? 'just now' : `${s} secs ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const EXPLORER = 'https://stellar.expert/explorer/testnet/tx';

export default function ActivityFeed() {
  const { activity } = usePoolStore();

  return (
    <Card>
      <h3 className="text-h3" style={{ marginBottom: '16px' }}>Recent Shielded Activity</h3>

      {activity.length === 0 ? (
        <p className="text-body" style={{ color: 'var(--text-muted)' }}>
          No activity yet. Shield or unshield assets to see them here.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {activity.map((act) => (
            <div
              key={`${act.type}-${act.id}`}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '12px', borderBottom: '1px solid var(--color-border)' }}
            >
              <div>
                <div className="text-body" style={{ fontWeight: 600 }}>{act.type}</div>
                <div className="text-caption" style={{ color: 'var(--text-muted)' }}>
                  {relativeTime(act.timestamp)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="text-mono">{act.amount} {act.asset}</div>
                {act.txHash ? (
                  <a
                    href={`${EXPLORER}/${act.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-caption"
                    style={{ color: 'var(--success)', textDecoration: 'none' }}
                  >
                    Confirmed ↗
                  </a>
                ) : (
                  <div className="text-caption" style={{ color: 'var(--success)' }}>Confirmed</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
