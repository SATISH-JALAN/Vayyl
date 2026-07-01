#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env,
};

#[contracttype]
#[derive(Clone, Debug)]
pub struct OrderState {
    pub commitment: BytesN<32>,
    pub escrow_amount: i128,
    pub pool: Address,
    pub active: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Verifier,
    SealedOrder(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    OrderNotFound = 3,
    OrderAlreadyExists = 4,
    ProofFailed = 5,
}

#[contract]
pub struct HiddenOrderRegistryContract;

#[contractimpl]
impl HiddenOrderRegistryContract {
    pub fn initialize(env: Env, verifier: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        Ok(())
    }

    /// Commit a hidden order (sealed stop-loss / take-profit)
    pub fn commit_order(
        env: Env,
        order_id: BytesN<32>,
        commitment: BytesN<32>,
        escrow_amount: i128,
        pool: Address,
    ) -> Result<(), Error> {
        if env.storage().persistent().has(&DataKey::SealedOrder(order_id.clone())) {
            return Err(Error::OrderAlreadyExists);
        }

        let state = OrderState {
            commitment,
            escrow_amount,
            pool,
            active: true,
        };
        env.storage().persistent().set(&DataKey::SealedOrder(order_id), &state);
        // TODO: Escrow funds via pool
        Ok(())
    }

    /// Reveal and execute a hidden order when trigger fires
    pub fn reveal_and_execute(
        _env: Env,
        _order_id: BytesN<32>,
        _proof: BytesN<256>,
        _oracle_price: i128,
        _recipient: Address,
    ) -> Result<(), Error> {
        // TODO: Sprint 6 implementation
        // 1. Verify HiddenOrderTrigger proof
        // 2. Call VayylPool.execute_settlement
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
        let contract_id = env.register(HiddenOrderRegistryContract, ());
        let client = HiddenOrderRegistryContractClient::new(&env, &contract_id);

        let verifier = Address::generate(&env);
        client.initialize(&verifier);
    }
}
