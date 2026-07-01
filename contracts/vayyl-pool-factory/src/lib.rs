#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, log,
    Address, BytesN, Env, IntoVal, Symbol,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Verifier,
    Membership,
    NonMembership,
    PoolWasm,
    /// Maps asset address to pool contract address
    Pool(Address),
    /// Total pools deployed
    PoolCount,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    PoolAlreadyExists = 3,
    WasmNotSet = 4,
    NotInitialized = 5,
}

#[contract]
pub struct VayylPoolFactoryContract;

#[contractimpl]
impl VayylPoolFactoryContract {
    /// Initialize the factory with admin, verifier, and ASP contract addresses
    pub fn initialize(
        env: Env,
        admin: Address,
        verifier: Address,
        membership: Address,
        non_membership: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::Membership, &membership);
        env.storage().instance().set(&DataKey::NonMembership, &non_membership);
        env.storage().instance().set(&DataKey::PoolCount, &0u32);
        
        log!(&env, "VayylPoolFactory initialized");
        Ok(())
    }

    /// Upload the VayylPool WASM hash so the factory can deploy new instances.
    /// Admin-gated.
    pub fn set_pool_wasm(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::PoolWasm, &wasm_hash);
        log!(&env, "Pool WASM hash set");
        Ok(())
    }

    /// Deploy a new VayylPool for the given asset.
    /// Uses Soroban's deployer to instantiate a new contract from the uploaded WASM.
    pub fn deploy_pool(env: Env, asset: Address) -> Result<Address, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        // Check pool doesn't already exist for this asset
        if env.storage().persistent().has(&DataKey::Pool(asset.clone())) {
            return Err(Error::PoolAlreadyExists);
        }

        let wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PoolWasm)
            .ok_or(Error::WasmNotSet)?;

        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).unwrap();
        let membership: Address = env.storage().instance().get(&DataKey::Membership).unwrap();
        let non_membership: Address = env.storage().instance().get(&DataKey::NonMembership).unwrap();

        use soroban_sdk::xdr::ToXdr;
        let mut salt_bytes = soroban_sdk::Bytes::new(&env);
        salt_bytes.append(&asset.clone().to_xdr(&env));
        let salt = env.crypto().sha256(&salt_bytes);

        // Deploy the new pool contract
        let pool_address = env
            .deployer()
            .with_current_contract(salt)
            .deploy_v2(wasm_hash, ());

        // Initialize the deployed pool
        let init_args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
            &env,
            asset.clone().into_val(&env),
            verifier.into_val(&env),
            membership.into_val(&env),
            non_membership.into_val(&env),
        ];
        env.invoke_contract::<()>(
            &pool_address,
            &Symbol::new(&env, "initialize"),
            init_args,
        );

        // Store the mapping
        env.storage()
            .persistent()
            .set(&DataKey::Pool(asset.clone()), &pool_address);
        env.storage().persistent().extend_ttl(
            &DataKey::Pool(asset),
            50000,
            100000,
        );

        // Increment pool count
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PoolCount)
            .unwrap_or(0);
        env.storage().instance().set(&DataKey::PoolCount, &(count + 1));

        log!(&env, "Pool deployed. Total pools: {}", count + 1);

        Ok(pool_address)
    }

    /// Get the pool address for a given asset
    pub fn get_pool(env: Env, asset: Address) -> Result<Address, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Pool(asset))
            .ok_or(Error::NotInitialized)
    }

    /// Update the verifier address (admin-gated)
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

    pub fn pool_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::PoolCount)
            .unwrap_or(0)
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
        let membership = Address::generate(&env);
        let non_membership = Address::generate(&env);
        client.initialize(&admin, &verifier, &membership, &non_membership);
        assert_eq!(client.admin(), admin);
        assert_eq!(client.pool_count(), 0);
    }
}
