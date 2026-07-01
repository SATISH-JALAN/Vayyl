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
    Leaf(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    NotAMember = 3,
}

#[contract]
pub struct AspMembershipContract;

#[contractimpl]
impl AspMembershipContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        let empty_root = BytesN::from_array(&env, &[0u8; 32]);
        env.storage().instance().set(&DataKey::Root, &empty_root);
        Ok(())
    }

    /// Insert an approved leaf (admin-gated)
    pub fn insert_leaf(env: Env, leaf: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        env.storage().persistent().set(&DataKey::Leaf(leaf), &true);
        // TODO: Update Merkle root
        Ok(())
    }

    /// Assert that a leaf is a member (for deposit flow)
    pub fn assert_member(
        env: Env,
        leaf: BytesN<32>,
        _proof: BytesN<256>,
        _index: u32,
    ) -> Result<bool, Error> {
        // TODO: Verify Merkle proof against stored root
        if env.storage().persistent().has(&DataKey::Leaf(leaf)) {
            Ok(true)
        } else {
            Err(Error::NotAMember)
        }
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
        let contract_id = env.register(AspMembershipContract, ());
        let client = AspMembershipContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);
    }
}
