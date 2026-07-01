#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    PositionManager,
    Verifier,
    GracePeriod,
    Heartbeat(BytesN<32>),
    KeeperEscrow(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    PositionNotStale = 3,
    HeartbeatNotFound = 4,
}

#[contract]
pub struct LiquidationEngineContract;

#[contractimpl]
impl LiquidationEngineContract {
    pub fn initialize(
        env: Env,
        position_manager: Address,
        verifier: Address,
        grace_period: u64,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::PositionManager) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::PositionManager, &position_manager);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::GracePeriod, &grace_period);
        Ok(())
    }

    /// Register a heartbeat for a position (callable by PositionManager only)
    pub fn register_heartbeat(
        env: Env,
        position_id: BytesN<32>,
        timestamp: u64,
    ) -> Result<(), Error> {
        // TODO: Verify caller is PositionManager
        env.storage().persistent().set(&DataKey::Heartbeat(position_id), &timestamp);
        Ok(())
    }

    /// Initiate liquidation for a stale position
    pub fn initiate_liquidation(
        env: Env,
        position_id: BytesN<32>,
        keeper_commitment: BytesN<32>,
    ) -> Result<(), Error> {
        let grace: u64 = env.storage().instance().get(&DataKey::GracePeriod).unwrap();
        let last_heartbeat: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Heartbeat(position_id.clone()))
            .ok_or(Error::HeartbeatNotFound)?;

        if env.ledger().timestamp() < last_heartbeat + grace {
            return Err(Error::PositionNotStale);
        }

        env.storage().persistent().set(
            &DataKey::KeeperEscrow(position_id),
            &keeper_commitment,
        );
        Ok(())
    }

    /// Reveal keeper secret and seize stale position's collateral
    pub fn reveal_and_seize(
        _env: Env,
        _position_id: BytesN<32>,
        _keeper_secret: BytesN<32>,
        _receiver: Address,
    ) -> Result<(), Error> {
        // TODO: Sprint 4 implementation
        // 1. Verify LiquidationHeartbeat proof
        // 2. Verify keeper_secret matches stored keeper_commitment
        // 3. Release collateral via SAC
        Ok(())
    }

    /// Check if a position is stale (past grace period without heartbeat)
    pub fn is_stale(env: Env, position_id: BytesN<32>) -> bool {
        let grace: u64 = env.storage().instance().get(&DataKey::GracePeriod).unwrap_or(0);
        let last_heartbeat: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::Heartbeat(position_id))
            .unwrap_or(0);
        env.ledger().timestamp() > last_heartbeat + grace
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register(LiquidationEngineContract, ());
        let client = LiquidationEngineContractClient::new(&env, &contract_id);

        let pm = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.initialize(&pm, &verifier, &3600u64);
    }
}
