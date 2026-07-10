import Card from '../common/Card';
import { AgenticQuest, useEscrowStore } from '../../store/escrow';

export default function QuestCard({ quest }: { quest: AgenticQuest }) {
  const { claimQuest, isProving } = useEscrowStore();

  const isClaimed = quest.status === 'claimed';
  const isActive = quest.status === 'active';

  return (
    <Card className="dapp-position-card">
      <div className="dapp-position-card__header">
        <div>
          <h3 className="dapp-position-card__title">Quest #{quest.quest_id.slice(0, 8)}</h3>
          <p className="dapp-position-card__subtitle">
            Reward: {quest.reward_amount} XLM
          </p>
        </div>
        <span className={`dapp-badge ${
          isActive ? 'dapp-badge--muted' : 
          isClaimed ? 'dapp-badge--success' : ''
        }`}>
          {quest.status.toUpperCase()}
        </span>
      </div>

      <div className="dapp-position-card__stats">
        <div className="dapp-stat" style={{ width: '100%' }}>
          <label>Task</label>
          <span>{quest.task_data}</span>
        </div>
      </div>

      {isActive && (
        <div className="dapp-position-card__actions">
          <button 
            className="dapp-button dapp-button--primary dapp-button--full"
            onClick={() => claimQuest(quest.quest_id)}
            disabled={isProving}
          >
            {isProving ? 'Generating ZK proof...' : 'Claim Reward (Simulate)'}
          </button>
        </div>
      )}
    </Card>
  );
}
