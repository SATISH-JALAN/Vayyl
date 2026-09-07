import Card from '../common/Card';
import { usePoolStore } from '../../store/pool';
import { EXPLORER_TX as EXPLORER, relativeTime, shortHash } from '../../lib/format';

interface ActivityFeedProps {
  activityCount?: number;
}

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
                    <span className="dapp-explorer-brand dapp-explorer-brand--compact"><img src="/brands/stellar-expert.png" alt="" />{shortHash(act.txHash)}</span>
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
