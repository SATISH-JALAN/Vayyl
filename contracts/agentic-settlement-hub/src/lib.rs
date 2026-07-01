#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env,
};

#[contracttype]
#[derive(Clone, Debug)]
pub struct QuestState {
    pub commitment: BytesN<32>,
    pub reward_amount: i128,
    pub pool: Address,
    pub claimed: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Verifier,
    Quest(BytesN<32>),
    AgentNullifier(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    QuestNotFound = 3,
    QuestAlreadyClaimed = 4,
    AgentNullifierSpent = 5,
    ProofFailed = 6,
}

#[contract]
pub struct AgenticSettlementHubContract;

#[contractimpl]
impl AgenticSettlementHubContract {
    pub fn initialize(env: Env, verifier: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        Ok(())
    }

    /// Create a quest — escrow a reward for an agent task
    pub fn create_quest(
        env: Env,
        quest_id: BytesN<32>,
        quest_commitment: BytesN<32>,
        reward_amount: i128,
        pool: Address,
    ) -> Result<(), Error> {
        let state = QuestState {
            commitment: quest_commitment,
            reward_amount,
            pool,
            claimed: false,
        };
        env.storage().persistent().set(&DataKey::Quest(quest_id), &state);
        // TODO: Escrow reward via pool
        Ok(())
    }

    /// Agent claims a quest reward with a proof
    pub fn claim_quest(
        env: Env,
        quest_id: BytesN<32>,
        _proof: BytesN<256>,
        agent_nullifier: BytesN<32>,
        _recipient: Address,
    ) -> Result<(), Error> {
        // Check agent_nullifier hasn't been used (prevent double-claim)
        if env.storage().persistent().has(&DataKey::AgentNullifier(agent_nullifier.clone())) {
            return Err(Error::AgentNullifierSpent);
        }

        let mut state: QuestState = env
            .storage()
            .persistent()
            .get(&DataKey::Quest(quest_id.clone()))
            .ok_or(Error::QuestNotFound)?;

        if state.claimed {
            return Err(Error::QuestAlreadyClaimed);
        }

        // TODO: Verify proof via Groth16Verifier
        // TODO: Call VayylPool.execute_settlement

        state.claimed = true;
        env.storage().persistent().set(&DataKey::Quest(quest_id), &state);
        env.storage().persistent().set(&DataKey::AgentNullifier(agent_nullifier), &true);
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register(AgenticSettlementHubContract, ());
        let client = AgenticSettlementHubContractClient::new(&env, &contract_id);

        let verifier = Address::generate(&env);
        client.initialize(&verifier);
    }
}
