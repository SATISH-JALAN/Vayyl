#![no_std]

use soroban_poseidon::poseidon2_hash;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, log,
    Address, BytesN, Env, Vec,
};

pub const ASP_TREE_DEPTH: u32 = 16; // Supports 65536 approved members

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Root,
    NextIndex,
    Frontier,
    Zeros,
    Leaf(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    NotAMember = 3,
    TreeFull = 4,
    LeafAlreadyExists = 5,
}

#[contract]
pub struct AspMembershipContract;

/// Compute Poseidon2 hash of two 32-byte inputs
fn hash2(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    let left_bytes: soroban_sdk::Bytes = left.clone().into();
    let right_bytes: soroban_sdk::Bytes = right.clone().into();
    let left_u256 = soroban_sdk::U256::from_be_bytes(env, &left_bytes);
    let right_u256 = soroban_sdk::U256::from_be_bytes(env, &right_bytes);
    
    let mut inputs = soroban_sdk::Vec::new(env);
    inputs.push_back(left_u256);
    inputs.push_back(right_u256);
    
    let result = poseidon2_hash::<3, soroban_sdk::crypto::bn254::Bn254Fr>(env, &inputs);
    let bytes = result.to_be_bytes();
    let mut array = [0u8; 32];
    
    let copy_len = array.len().min(bytes.len() as usize);
    bytes.slice(0..copy_len as u32).copy_into_slice(&mut array[32 - copy_len..]);
    
    BytesN::from_array(env, &array)
}

#[contractimpl]
impl AspMembershipContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextIndex, &0u32);

        // Precompute zero hashes for the empty tree
        let mut zeros: Vec<BytesN<32>> = Vec::new(&env);
        let zero_leaf = BytesN::from_array(&env, &[0u8; 32]);
        zeros.push_back(zero_leaf.clone());

        let mut current = zero_leaf;
        for _ in 1..=ASP_TREE_DEPTH {
            current = hash2(&env, &current, &current);
            zeros.push_back(current.clone());
        }

        env.storage().persistent().set(&DataKey::Zeros, &zeros);
        env.storage().instance().set(&DataKey::Root, &current);

        let frontier: Vec<BytesN<32>> = Vec::new(&env);
        env.storage().persistent().set(&DataKey::Frontier, &frontier);

        log!(&env, "ASP Membership initialized with tree depth {}", ASP_TREE_DEPTH);
        Ok(())
    }

    /// Insert an approved leaf into the ASP Merkle tree (admin-gated).
    /// Uses frontier-based insertion identical to VayylPool's Merkle tree.
    pub fn insert_leaf(env: Env, leaf: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        // Prevent duplicate insertion
        if env.storage().persistent().has(&DataKey::Leaf(leaf.clone())) {
            return Err(Error::LeafAlreadyExists);
        }

        let index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextIndex)
            .unwrap_or(0);

        if index >= (1u32 << ASP_TREE_DEPTH) {
            return Err(Error::TreeFull);
        }

        let zeros: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::Zeros)
            .unwrap();

        let mut frontier: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::Frontier)
            .unwrap_or_else(|| Vec::new(&env));

        // Ensure frontier has ASP_TREE_DEPTH slots
        while frontier.len() < ASP_TREE_DEPTH {
            frontier.push_back(BytesN::from_array(&env, &[0u8; 32]));
        }

        let mut current_hash = leaf.clone();
        let mut current_index = index;

        for level in 0..ASP_TREE_DEPTH {
            if current_index & 1 == 0 {
                frontier.set(level, current_hash.clone());
                current_hash = hash2(&env, &current_hash, &zeros.get(level).unwrap());
            } else {
                let left = frontier.get(level).unwrap();
                current_hash = hash2(&env, &left, &current_hash);
            }
            current_index >>= 1;
        }

        // Store the leaf, update index and root
        env.storage().persistent().set(&DataKey::Leaf(leaf), &index);
        env.storage().instance().set(&DataKey::NextIndex, &(index + 1));
        env.storage().persistent().set(&DataKey::Frontier, &frontier);
        env.storage().instance().set(&DataKey::Root, &current_hash);

        // Extend TTLs
        env.storage().persistent().extend_ttl(&DataKey::Frontier, 50000, 100000);
        env.storage().persistent().extend_ttl(&DataKey::Zeros, 50000, 100000);

        log!(&env, "ASP leaf inserted at index {}. Root updated.", index);
        Ok(())
    }

    /// Verify membership: check that the leaf exists in storage.
    /// The ZK circuit handles the actual Merkle proof verification off-chain,
    /// and the on-chain contract verifies the Groth16 proof that includes the ASP root.
    /// This on-chain check is a secondary validation.
    pub fn is_member(env: Env, leaf: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Leaf(leaf))
    }

    /// Get the leaf index for a given leaf
    pub fn get_leaf_index(env: Env, leaf: BytesN<32>) -> Result<u32, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Leaf(leaf))
            .ok_or(Error::NotAMember)
    }

    pub fn root(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::Root)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]))
    }

    pub fn leaf_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::NextIndex)
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
        let contract_id = env.register(AspMembershipContract, ());
        let client = AspMembershipContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert_eq!(client.leaf_count(), 0);
    }

    #[test]
    fn test_insert_and_membership() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(AspMembershipContract, ());
        let client = AspMembershipContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let leaf = BytesN::from_array(&env, &[42u8; 32]);
        client.insert_leaf(&leaf);

        assert!(client.is_member(&leaf));
        assert_eq!(client.leaf_count(), 1);
        assert_eq!(client.get_leaf_index(&leaf), 0);

        // Root should have changed from initial
        let root = client.root();
        assert_ne!(root, BytesN::from_array(&env, &[0u8; 32]));
    }
}
