#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Root,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    IsBlocklisted = 3,
}

#[contract]
pub struct AspNonMembershipContract;

#[contractimpl]
impl AspNonMembershipContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        let empty_root = BytesN::from_array(&env, &[0u8; 32]);
        env.storage().instance().set(&DataKey::Root, &empty_root);
        Ok(())
    }

    /// Exclude an address (add to blocklist) — admin-gated
    pub fn exclude_address(env: Env, leaf: BytesN<32>, _proof: BytesN<256>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();
        // TODO: Update sparse Merkle tree to include leaf
        Ok(())
    }

    /// Assert that a leaf is NOT a member (prove not blocklisted)
    pub fn assert_non_member(
        _env: Env,
        _leaf: BytesN<32>,
        _proof: BytesN<256>,
    ) -> Result<bool, Error> {
        // TODO: Verify sparse Merkle tree proof showing empty leaf
        Ok(true)
    }

    pub fn root(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::Root)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register(AspNonMembershipContract, ());
        let client = AspNonMembershipContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);
    }
}
