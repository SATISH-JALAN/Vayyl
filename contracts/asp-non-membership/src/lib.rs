//! ASP non-membership blocklist (V1 scope).
//!
//! **V1:** storage-backed blocklist + running-hash root. `is_not_blocked` is a
//! lookup used by `VayylPool::transfer` / `withdraw` when this contract is
//! initialized. There is no circuit-verifiable sparse Merkle non-membership
//! proof in V1 — that requires `asp_non_membership.circom` + a real sparse tree
//! (V2 upgrade via `upgrade()`).

#![no_std]

use soroban_poseidon::poseidon2_hash;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, log,
    Address, BytesN, Env,
};

/// Sparse Merkle Tree depth for the blocklist.
/// A sparse tree can prove both inclusion and NON-inclusion.
/// Non-membership is proved by showing the leaf slot is empty (zero).
pub const SPARSE_TREE_DEPTH: u32 = 16;

/// Persistent TTL policy (kept in sync with vayyl-pool / asp-membership).
pub const PERSISTENT_TTL_THRESHOLD: u32 = 1_000_000;
pub const PERSISTENT_TTL_EXTEND: u32 = 3_000_000;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Root,
    /// Stores blocked leaves (the leaf hash maps to true)
    BlockedLeaf(BytesN<32>),
    /// Total number of blocked leaves
    BlockedCount,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    IsBlocklisted = 3,
    AlreadyBlocked = 4,
}

#[contract]
pub struct AspNonMembershipContract;

/// Compute Poseidon2 hash of two 32-byte inputs
fn hash2(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    let left_bytes: soroban_sdk::Bytes = left.clone().into();
    let right_bytes: soroban_sdk::Bytes = right.clone().into();
    // Reduce to the canonical field representative (< BN254 modulus) before
    // hashing. poseidon2_hash panics on any input >= the modulus, and ~1/8 of
    // arbitrary 32-byte values (user commitments, SHA-256 outputs) exceed it.
    // Bn254Fr::from_u256(..).to_u256() applies the field's own reduction, which
    // matches how the Circom circuit interprets these signals (value mod p).
    let left_u256 = soroban_sdk::crypto::bn254::Bn254Fr::from_u256(
        soroban_sdk::U256::from_be_bytes(env, &left_bytes)).to_u256();
    let right_u256 = soroban_sdk::crypto::bn254::Bn254Fr::from_u256(
        soroban_sdk::U256::from_be_bytes(env, &right_bytes)).to_u256();
    
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

/// Compute the root of an empty sparse Merkle tree of the given depth
fn empty_sparse_root(env: &Env, depth: u32) -> BytesN<32> {
    let mut current = BytesN::from_array(env, &[0u8; 32]);
    for _ in 0..depth {
        current = hash2(env, &current, &current);
    }
    current
}

#[contractimpl]
impl AspNonMembershipContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::BlockedCount, &0u32);

        // Compute the empty sparse Merkle root
        let empty_root = empty_sparse_root(&env, SPARSE_TREE_DEPTH);
        env.storage().instance().set(&DataKey::Root, &empty_root);

        log!(&env, "ASP Non-Membership initialized. Sparse tree depth: {}", SPARSE_TREE_DEPTH);
        Ok(())
    }

    /// Add a leaf to the blocklist (admin-gated).
    /// In a full implementation, this would update a sparse Merkle tree.
    /// For the buildathon, we track blocked leaves in storage and update the root
    /// by hashing the new leaf into the existing root (simplified but functional).
    pub fn block_leaf(env: Env, leaf: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        if env.storage().persistent().has(&DataKey::BlockedLeaf(leaf.clone())) {
            return Err(Error::AlreadyBlocked);
        }

        // Store the blocked leaf
        env.storage().persistent().set(&DataKey::BlockedLeaf(leaf.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::BlockedLeaf(leaf.clone()),
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // Update the root: new_root = Poseidon2(old_root, leaf)
        // This is a simplified sparse tree update. In production, you'd track the
        // full path and update exactly the right nodes. For the buildathon,
        // this produces a deterministic, unique root per blocklist state.
        let old_root: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Root)
            .unwrap();
        let new_root = hash2(&env, &old_root, &leaf);
        env.storage().instance().set(&DataKey::Root, &new_root);

        // Increment count
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::BlockedCount)
            .unwrap_or(0);
        env.storage().instance().set(&DataKey::BlockedCount, &(count + 1));

        log!(&env, "Leaf blocked. Total blocked: {}", count + 1);
        Ok(())
    }

    /// Check that a leaf is NOT blocklisted.
    /// Returns true if the leaf is NOT in the blocklist (i.e., the address is clean).
    /// In the full system, the ZK circuit verifies a sparse Merkle non-membership proof,
    /// and this on-chain check is a secondary validation.
    pub fn is_not_blocked(env: Env, leaf: BytesN<32>) -> bool {
        !env.storage().persistent().has(&DataKey::BlockedLeaf(leaf))
    }

    /// Assert non-membership. Returns Ok(true) if leaf is not blocked.
    pub fn assert_non_member(env: Env, leaf: BytesN<32>) -> Result<bool, Error> {
        if env.storage().persistent().has(&DataKey::BlockedLeaf(leaf)) {
            Err(Error::IsBlocklisted)
        } else {
            Ok(true)
        }
    }

    pub fn root(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::Root)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]))
    }

    pub fn blocked_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::BlockedCount)
            .unwrap_or(0)
    }

    /// Get the admin authorized to upgrade this contract.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)
    }

    /// Upgrade the contract's WASM code in place (admin-gated).
    /// Keeps the blocklist and sparse-tree root intact.
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
        let contract_id = env.register(AspNonMembershipContract, ());
        let client = AspNonMembershipContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert_eq!(client.blocked_count(), 0);
    }

    #[test]
    fn test_block_and_check() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(AspNonMembershipContract, ());
        let client = AspNonMembershipContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let clean_leaf = BytesN::from_array(&env, &[1u8; 32]);
        let bad_leaf = BytesN::from_array(&env, &[99u8; 32]);

        // Block the bad leaf
        client.block_leaf(&bad_leaf);

        // Clean leaf should pass
        assert!(client.is_not_blocked(&clean_leaf));
        assert_eq!(client.assert_non_member(&clean_leaf), true);

        // Bad leaf should fail
        assert!(!client.is_not_blocked(&bad_leaf));
        assert_eq!(client.blocked_count(), 1);
    }

    // C2 regression: a leaf whose 32-byte value is >= the BN254 field modulus
    // must hash without panicking. [0xFF; 32] = 2^256 - 1, well above the prime;
    // before field reduction was added to hash2() this trapped the whole tx
    // ("input exceeds field modulus"). ~1/8 of arbitrary 32-byte values hit this.
    #[test]
    fn test_block_leaf_above_field_modulus() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(AspNonMembershipContract, ());
        let client = AspNonMembershipContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        // Value strictly greater than the BN254 scalar modulus.
        let over_modulus_leaf = BytesN::from_array(&env, &[0xFFu8; 32]);

        // Must not panic; must update the root and mark the leaf blocked.
        client.block_leaf(&over_modulus_leaf);
        assert_eq!(client.blocked_count(), 1);
        assert!(!client.is_not_blocked(&over_modulus_leaf));
    }
}
