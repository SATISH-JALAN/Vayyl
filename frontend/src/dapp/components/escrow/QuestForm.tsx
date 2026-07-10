import { useState } from 'react';
import Card from '../common/Card';
import { useEscrowStore } from '../../store/escrow';

export default function QuestForm() {
  const [rewardAmount, setRewardAmount] = useState('');
  const [taskData, setTaskData] = useState('');
  
  const { createQuest, isProving } = useEscrowStore();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rewardAmount || !taskData) return;
    void createQuest(rewardAmount, taskData);
  };

  return (
    <Card className="dapp-card--strong">
      <div className="dapp-card__header">
        <div>
          <h2 className="dapp-card__title">Create agentic quest</h2>
          <p className="dapp-card__description">
            Lock a reward for a verifiable task. The bounty is settled permissionlessly to the first agent providing a valid proof.
          </p>
        </div>
      </div>

      <form className="dapp-form" onSubmit={handleSubmit}>
        <div className="dapp-form__group">
          <label>Reward amount (XLM)</label>
          <div className="dapp-input-wrapper">
            <input
              type="number"
              placeholder="0.0"
              value={rewardAmount}
              onChange={(e) => setRewardAmount(e.target.value)}
              disabled={isProving}
              min="1"
              required
            />
            <span className="dapp-input-suffix">XLM</span>
          </div>
        </div>

        <div className="dapp-form__group">
          <label>Task description</label>
          <div className="dapp-input-wrapper">
            <input
              type="text"
              placeholder="e.g., Liquidate position #1234"
              value={taskData}
              onChange={(e) => setTaskData(e.target.value)}
              disabled={isProving}
              required
            />
          </div>
        </div>

        <button 
          type="submit" 
          className="dapp-button dapp-button--primary dapp-button--full"
          disabled={isProving || !rewardAmount || !taskData}
        >
          {isProving ? 'Creating...' : 'Lock quest reward'}
        </button>
      </form>
    </Card>
  );
}
