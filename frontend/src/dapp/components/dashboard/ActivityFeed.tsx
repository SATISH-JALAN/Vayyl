import Card from '../common/Card';
import { usePoolStore } from '../../store/pool';

interface ActivityFeedProps {
  activityCount?: number;
}

function relativeTime(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return seconds <= 1 ? 'just now' : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

const EXPLORER = 'https://stellar.expert/explorer/public/tx';

export default function ActivityFeed({ activityCount }: ActivityFeedProps) {
  const { activity } = usePoolStore();

  return (
    <Card>
      <div className="dapp-card__header">
        <div>
          <h2 className="dapp-card__title">Recent activity</h2>
          <p className="dapp-card__description">
            {activityCount ?? activity.length} settlement event{(activityCount ?? activity.length) === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {activity.length === 0 ? (
        <div className="dapp-empty">
          <strong>No activity yet</strong>
          <p>Shield or unshield XLM to populate this feed with settlement activity and transaction links.</p>
        </div>
      ) : (
        <div className="dapp-activity-list">
          {activity.map((act) => (
            <div className="dapp-activity-item" key={`${act.type}-${act.id}`}>
              <div>
                <strong>{act.type}</strong>
                <p className="dapp-helper">{relativeTime(act.timestamp)}</p>
              </div>
              <div>
                <div className="dapp-activity-item__amount">
                  {act.amount} {act.asset}
                </div>
                {act.txHash ? (
                  <a
                    className="dapp-helper"
                    href={`${EXPLORER}/${act.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortHash(act.txHash)}
                  </a>
                ) : (
                  <p className="dapp-helper">Local</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
