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
        // The factory's admin also governs `upgrade()` on every pool it deploys,
        // so one key can push a fix to all pools without redeploying them.
        let pool_admin: Address = admin.clone();

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
            pool_admin.into_val(&env),
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
            1000000,
            3000000,
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

    /// Upgrade the factory's WASM code in place (admin-gated).
    /// Keeps the deployed-pool registry and config intact. Note: this upgrades
    /// only the factory; each pool is upgraded via its own `upgrade()`.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
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

    mod pool {
        soroban_sdk::contractimport!(
            file = "../target/wasm32v1-none/release/vayyl_pool.wasm"
        );
    }

    #[soroban_sdk::contract]
    pub struct MockVerifier;
    #[soroban_sdk::contractimpl]
    impl MockVerifier {
        pub fn verify(
            _env: Env,
            _circuit_id: soroban_sdk::Val,
            _proof: soroban_sdk::Val,
            _public_inputs: soroban_sdk::Val,
        ) -> Result<bool, soroban_sdk::Error> {
            Ok(true)
        }
    }

    #[soroban_sdk::contract]
    pub struct MockAsp;
    #[soroban_sdk::contractimpl]
    impl MockAsp {
        pub fn is_known_root(_env: Env, _root: soroban_sdk::BytesN<32>) -> bool {
            true
        }
    }

    #[soroban_sdk::contract]
    pub struct MockNonMembership;
    #[soroban_sdk::contractimpl]
    impl MockNonMembership {
        pub fn is_not_blocked(_env: Env, _nullifier: soroban_sdk::BytesN<32>) -> bool {
            true
        }
    }

    #[test]
    fn test_deploy_and_deposit_withdraw() {
        let env = Env::default();
        env.mock_all_auths();

        let factory_id = env.register(VayylPoolFactoryContract, ());
        let factory = VayylPoolFactoryContractClient::new(&env, &factory_id);

        let admin = Address::generate(&env);
        
        let verifier_id = env.register(MockVerifier, ());
        let membership_id = env.register(MockAsp, ());
        let non_membership_id = env.register(MockNonMembership, ());

        factory.initialize(&admin, &verifier_id, &membership_id, &non_membership_id);

        let wasm_hash = env.deployer().upload_contract_wasm(pool::WASM);
        factory.set_pool_wasm(&wasm_hash);

        // deploy SAC
        let asset_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(asset_admin);
        let asset = sac.address();

        let pool_address = factory.deploy_pool(&asset);
        assert_eq!(factory.pool_count(), 1);

        let pool_client = pool::Client::new(&env, &pool_address);
        assert_eq!(pool_client.admin(), admin);

        // Fund user
        let user = Address::generate(&env);
        let token_admin_client = soroban_sdk::token::StellarAssetClient::new(&env, &asset);
        token_admin_client.mint(&user, &1000);

        // Deposit
        let proof = pool::Groth16Proof {
            a: soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
            b: soroban_sdk::BytesN::from_array(&env, &[0u8; 128]),
            c: soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        };
        let commitment = soroban_sdk::BytesN::from_array(&env, &[1u8; 32]);
        let asp_root = soroban_sdk::BytesN::from_array(&env, &[2u8; 32]);

        pool_client.deposit(&user, &proof, &commitment, &500, &asp_root);
        
        let token_client = soroban_sdk::token::Client::new(&env, &asset);
        assert_eq!(token_client.balance(&user), 500);
        assert_eq!(token_client.balance(&pool_address), 500);
        assert_eq!(pool_client.get_leaf_count(), 1);

        // Withdraw
        let pool_root = pool_client.get_root();
        let nullifier = soroban_sdk::BytesN::from_array(&env, &[3u8; 32]);
        pool_client.withdraw(&proof, &nullifier, &500, &user, &pool_root, &0, &user);
        
        assert_eq!(token_client.balance(&user), 1000);
        assert_eq!(token_client.balance(&pool_address), 0);
    }

}
