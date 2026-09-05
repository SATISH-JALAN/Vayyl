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
    /// C1: `leaf` is >= the BN254 scalar modulus. Blocking a non-canonical
    /// alias would be worse than useless -- it reads as an effective block
    /// while the canonical nullifier stays spendable.
    NonCanonicalFieldElement = 5,
}

/// H8: keep the contract's INSTANCE entry alive.
///
/// The admin, the blocklist root and the blocked count live in instance storage, and nothing extended it. When the instance
/// archives the contract stops working entirely until someone submits a
/// RestoreFootprint. Called on every state-changing entrypoint, where the
/// transaction is already paying for storage.
fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
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
        extend_instance_ttl(&env);
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
        extend_instance_ttl(&env);
        if !vayyl_types::is_canonical_fr(&leaf) {
            return Err(Error::NonCanonicalFieldElement);
        }
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
        // Fail CLOSED on a non-canonical leaf. This returns a bare bool, so the
        // honest-looking answer for an alias of a blocked nullifier would be
        // "not blocked" -- which is exactly the C1/D2 bypass. Report it as
        // blocked instead; a legitimate caller never supplies one.
        if !vayyl_types::is_canonical_fr(&leaf) {
            return false;
        }
        !env.storage().persistent().has(&DataKey::BlockedLeaf(leaf))
    }

    /// Assert non-membership. Returns Ok(true) if leaf is not blocked.
    pub fn assert_non_member(env: Env, leaf: BytesN<32>) -> Result<bool, Error> {
        if !vayyl_types::is_canonical_fr(&leaf) {
            return Err(Error::NonCanonicalFieldElement);
        }
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
        extend_instance_ttl(&env);
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
        let bad_leaf = BytesN::from_array(&env, &[0x13u8; 32]);

        // Block the bad leaf
        client.block_leaf(&bad_leaf);

        // Clean leaf should pass
        assert!(client.is_not_blocked(&clean_leaf));
        assert_eq!(client.assert_non_member(&clean_leaf), true);

        // Bad leaf should fail
        assert!(!client.is_not_blocked(&bad_leaf));
        assert_eq!(client.blocked_count(), 1);
    }

    // C1 -- SUPERSEDES the earlier C2 regression that lived here.
    //
    // That test asserted the OPPOSITE: that `block_leaf([0xFF; 32])` succeeds.
    // It was written when `hash2` panicked on inputs above the modulus, and the
    // fix was to reduce before hashing. Reducing stopped the trap, but it also
    // made such a block MEANINGLESS -- `DataKey::BlockedLeaf` is keyed on the
    // RAW bytes, so blocking `n + k*r` leaves the canonical `n` perfectly
    // spendable while the admin sees a successful block. A compliance control
    // that reports success without taking effect is worse than a refused call,
    // so the entrypoint now rejects instead.
    #[test]
    fn test_block_leaf_rejects_values_at_or_above_the_field_modulus() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(AspNonMembershipContract, ());
        let client = AspNonMembershipContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        // 2^256 - 1, far above r.
        let over_modulus = BytesN::from_array(&env, &[0xFFu8; 32]);
        assert_eq!(
            client.try_block_leaf(&over_modulus),
            Err(Ok(Error::NonCanonicalFieldElement)),
        );

        // Exactly r reduces to zero, so it is the sharpest boundary case.
        let exactly_r = BytesN::from_array(&env, &vayyl_types::BN254_FR_MODULUS_BE);
        assert_eq!(
            client.try_block_leaf(&exactly_r),
            Err(Ok(Error::NonCanonicalFieldElement)),
        );

        // r - 1 is the largest legal value and must still be accepted.
        let mut r_minus_1 = vayyl_types::BN254_FR_MODULUS_BE;
        r_minus_1[31] -= 1;
        let largest_legal = BytesN::from_array(&env, &r_minus_1);
        client.block_leaf(&largest_legal);
        assert_eq!(client.blocked_count(), 1);
        assert!(!client.is_not_blocked(&largest_legal));

        // The rejected calls stored nothing: the count is still 1 from the
        // legal insert above. Note we deliberately do NOT assert
        // `is_not_blocked(&over_modulus)` here -- that returns false, because
        // the query fails CLOSED on any non-canonical input by design.
        assert_eq!(client.blocked_count(), 1);
    }

    // D2: the bypass this closes. A blocked nullifier `n` must not become
    // spendable simply by presenting `n + r`, which the verifier reduces to the
    // same scalar. `is_not_blocked` returns a bare bool, so it fails CLOSED.
    #[test]
    fn test_alias_of_a_blocked_leaf_is_not_reported_unblocked() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(AspNonMembershipContract, ());
        let client = AspNonMembershipContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let n = [0x13u8; 32];
        client.block_leaf(&BytesN::from_array(&env, &n));

        // n + r, computed big-endian with carry.
        let mut alias = [0u8; 32];
        let mut carry = 0u16;
        for i in (0..32).rev() {
            let sum = n[i] as u16 + vayyl_types::BN254_FR_MODULUS_BE[i] as u16 + carry;
            alias[i] = (sum & 0xff) as u8;
            carry = sum >> 8;
        }
        let alias = BytesN::from_array(&env, &alias);

        assert!(
            !client.is_not_blocked(&alias),
            "an alias of a blocked leaf was reported as not blocked -- D2 bypass",
        );
        assert_eq!(
            client.try_assert_non_member(&alias),
            Err(Ok(Error::NonCanonicalFieldElement)),
        );
    }
}
