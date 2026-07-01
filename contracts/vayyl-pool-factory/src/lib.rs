#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Verifier,
    PoolWasm,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    PoolAlreadyExists = 3,
}

#[contract]
pub struct VayylPoolFactoryContract;

#[contractimpl]
impl VayylPoolFactoryContract {
    pub fn initialize(env: Env, admin: Address, verifier: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        Ok(())
    }

    /// Deploy a new VayylPool for the given asset
    pub fn deploy_pool(
        _env: Env,
        _asset: Address,
    ) -> Result<Address, Error> {
        // TODO: Sprint 2 — use Soroban deployer to instantiate VayylPool
        Err(Error::Unauthorized)
    }

    pub fn set_verifier(env: Env, verifier: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        Ok(())
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(VayylPoolFactoryContract, ());
        let client = VayylPoolFactoryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.initialize(&admin, &verifier);
        assert_eq!(client.admin(), admin);
    }
}
