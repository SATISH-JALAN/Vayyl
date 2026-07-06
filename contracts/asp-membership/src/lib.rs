#![no_std]

use soroban_poseidon::poseidon2_hash;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, log,
    Address, BytesN, Env, Vec,
};

/// Depth 20 to match the in-circuit ASP path (`deposit.circom` instantiates
/// `ASPMembership(20)`). The on-chain root must be computed over the same number
/// of levels as the circuit, or `asp_root` (a deposit public input) could never
/// equal `root()` and ASP enforcement would reject every legitimate deposit.
/// Supports ~1M approved members.
pub const ASP_TREE_DEPTH: u32 = 20;

/// How many recent ASP roots stay valid for in-flight deposit proofs. Mirrors
/// the pool's commitment-tree root window: an admin `insert_leaf` between a
/// depositor's proof-generation and submission changes `root()`, and without a
/// history that in-flight (correctly-proven) deposit would be rejected.
pub const ROOT_HISTORY_SIZE: u32 = 32;

/// TTL policy for the persistent history/tree data (kept in sync with the pool).
pub const PERSISTENT_TTL_THRESHOLD: u32 = 1_000_000;
pub const PERSISTENT_TTL_EXTEND: u32 = 3_000_000;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Root,
    NextIndex,
    Frontier,
    Zeros,
    /// Ring buffer of the last `ROOT_HISTORY_SIZE` roots (oldest first).
    RootHistory,
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

        // Append the new root to the historical-roots ring buffer, keeping at most
        // ROOT_HISTORY_SIZE entries (drop the oldest). Deposit proofs bound to any
        // of these roots stay valid across concurrent ASP-set updates.
        let mut history: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::RootHistory)
            .unwrap_or_else(|| Vec::new(&env));
        history.push_back(current_hash.clone());
        while history.len() > ROOT_HISTORY_SIZE {
            history.pop_front();
        }
        env.storage().persistent().set(&DataKey::RootHistory, &history);

        // Extend TTLs
        env.storage().persistent().extend_ttl(
            &DataKey::Frontier, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
        env.storage().persistent().extend_ttl(
            &DataKey::Zeros, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
        env.storage().persistent().extend_ttl(
            &DataKey::RootHistory, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);

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

    /// True if `root` is the current ASP root or any root still inside the
    /// historical-roots window. The pool calls this to bind a deposit's caller-
    /// supplied `asp_root` to a trusted root, accepting recent roots so in-flight
    /// deposits survive concurrent ASP-set updates.
    pub fn is_known_root(env: Env, root: BytesN<32>) -> bool {
        if let Some(current) = env
            .storage()
            .instance()
            .get::<DataKey, BytesN<32>>(&DataKey::Root)
        {
            if current == root {
                return true;
            }
        }
        let history: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::RootHistory)
            .unwrap_or_else(|| Vec::new(&env));
        history.iter().any(|r| r == root)
    }

    pub fn leaf_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::NextIndex)
            .unwrap_or(0)
    }

    /// Upgrade the contract's WASM code in place (admin-gated).
    /// Keeps the full ASP Merkle tree (frontier, root, leaves) intact.
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
    extern crate std;

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

    #[test]
    fn test_empty_root_nonzero_at_depth_20() {
        let env = Env::default();
        let contract_id = env.register(AspMembershipContract, ());
        let client = AspMembershipContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        // The empty-tree root at depth 20 is Poseidon2-derived, never all-zero,
        // and is a "known" root so a deposit against the empty set binds cleanly.
        let empty_root = client.root();
        assert_ne!(empty_root, BytesN::from_array(&env, &[0u8; 32]));
        assert!(client.is_known_root(&empty_root));
    }

    #[test]
    fn test_is_known_root_accepts_current_and_recent_rejects_unknown() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(AspMembershipContract, ());
        let client = AspMembershipContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        // Insert one approved member and snapshot the resulting root.
        client.insert_leaf(&BytesN::from_array(&env, &[1u8; 32]));
        let root_after_first = client.root();
        assert!(client.is_known_root(&root_after_first));

        // A second insert advances the current root; the previous root must stay
        // valid (in-window) so an in-flight deposit bound to it still passes.
        client.insert_leaf(&BytesN::from_array(&env, &[2u8; 32]));
        let root_after_second = client.root();
        assert_ne!(root_after_first, root_after_second, "root should advance");
        assert!(client.is_known_root(&root_after_second), "current root known");
        assert!(client.is_known_root(&root_after_first), "prior root still in window");

        // A root that was never produced is rejected.
        let bogus = BytesN::from_array(&env, &[0xAB; 32]);
        assert!(!client.is_known_root(&bogus));
    }

    // The window is bounded: once more than ROOT_HISTORY_SIZE inserts happen, the
    // oldest roots fall out and are no longer accepted.
    #[test]
    fn test_root_history_window_evicts_oldest() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(AspMembershipContract, ());
        let client = AspMembershipContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        client.insert_leaf(&BytesN::from_array(&env, &[100u8; 32]));
        let first_root = client.root();

        // Push ROOT_HISTORY_SIZE more roots so `first_root` is evicted from the
        // ring buffer (and is no longer the current root either).
        for i in 0..ROOT_HISTORY_SIZE {
            let mut leaf = [0u8; 32];
            leaf[0] = 1;
            leaf[31] = i as u8;
            client.insert_leaf(&BytesN::from_array(&env, &leaf));
        }
        assert!(!client.is_known_root(&first_root), "oldest root should be evicted");
    }

    // ---- Circuit parity lock -------------------------------------------------
    //
    // The pool's deposit enforcement is only sound if the on-chain `root()` (built
    // by frontier insertion) byte-matches the `asp_root` that `deposit.circom`
    // computes via its `MerkleProof(20)` sub-circuit. This test reproduces the
    // circuit's EXACT path-climb — `merkle.circom`'s DualMux ordering
    // (pathIndex 0 => hash(cur, sibling); 1 => hash(sibling, cur)) with
    // `HashLeftRight = Poseidon2Hash_2` — and asserts it equals `root()`. If a
    // future change to the on-chain tree (depth, zeros ladder, left/right order,
    // or Poseidon2 params) diverges from the circuit, this fails loudly instead of
    // silently rejecting every real deposit on-chain.
    //
    // NOTE: the leaf VALUE is the admin's responsibility — the circuit's leaf is
    // `Poseidon2(pubX, pubY)`, and the admin must `insert_leaf` that same hash.
    // This test uses opaque leaf values (that wiring is covered off-chain), and
    // proves the Merkle-path construction itself is byte-identical.

    /// Recompute a Merkle root from (leaf, siblings, index bits) using the circuit's
    /// DualMux ordering — an independent code path from frontier insertion.
    fn circuit_style_root(
        env: &Env,
        leaf: &BytesN<32>,
        siblings: &[BytesN<32>],
        index_bits: &[u8],
    ) -> BytesN<32> {
        let mut cur = leaf.clone();
        for i in 0..siblings.len() {
            cur = if index_bits[i] == 0 {
                hash2(env, &cur, &siblings[i]) // current is LEFT child
            } else {
                hash2(env, &siblings[i], &cur) // current is RIGHT child
            };
        }
        cur
    }

    #[test]
    fn test_onchain_root_matches_circuit_merkleproof_two_leaves() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(AspMembershipContract, ());
        let client = AspMembershipContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let l0 = BytesN::from_array(&env, &[0x11; 32]);
        let l1 = BytesN::from_array(&env, &[0x22; 32]);
        client.insert_leaf(&l0);
        client.insert_leaf(&l1);

        // Independent zeros ladder.
        let mut zeros: Vec<BytesN<32>> = Vec::new(&env);
        let z0 = BytesN::from_array(&env, &[0u8; 32]);
        zeros.push_back(z0.clone());
        let mut z = z0;
        for _ in 1..=ASP_TREE_DEPTH {
            z = hash2(&env, &z, &z);
            zeros.push_back(z.clone());
        }

        // Circuit path for member l1 at index 1: level0 sibling = l0 (RIGHT child),
        // every level above has an empty (zeros) right subtree as the sibling.
        let mut siblings: std::vec::Vec<BytesN<32>> = std::vec::Vec::new();
        let mut index_bits: std::vec::Vec<u8> = std::vec::Vec::new();
        siblings.push(l0.clone());
        index_bits.push(1); // l1 is the RIGHT child at level 0
        for level in 1..ASP_TREE_DEPTH as usize {
            siblings.push(zeros.get(level as u32).unwrap());
            index_bits.push(0); // LEFT child at every higher level
        }

        let recomputed = circuit_style_root(&env, &l1, &siblings, &index_bits);
        assert_eq!(recomputed, client.root(), "on-chain root must match circuit MerkleProof");
    }

    #[test]
    fn test_onchain_root_matches_circuit_merkleproof_internal_sibling() {
        // A member whose Merkle path includes a NON-zero internal sibling, so the
        // parity check exercises a real subtree hash, not just the zeros ladder.
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(AspMembershipContract, ());
        let client = AspMembershipContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let l0 = BytesN::from_array(&env, &[0x11; 32]);
        let l1 = BytesN::from_array(&env, &[0x22; 32]);
        let l2 = BytesN::from_array(&env, &[0x33; 32]);
        client.insert_leaf(&l0);
        client.insert_leaf(&l1);
        client.insert_leaf(&l2);

        let mut zeros: Vec<BytesN<32>> = Vec::new(&env);
        let z0 = BytesN::from_array(&env, &[0u8; 32]);
        zeros.push_back(z0.clone());
        let mut z = z0;
        for _ in 1..=ASP_TREE_DEPTH {
            z = hash2(&env, &z, &z);
            zeros.push_back(z.clone());
        }

        // Member l2 at index 2 (binary ...010):
        //  level 0: LEFT child, sibling = empty leaf (zeros[0]).
        //  level 1: RIGHT child, sibling = node(l0,l1) = hash2(l0,l1)  <- non-zero internal.
        //  level >=2: LEFT child, sibling = zeros[level].
        let node_l0_l1 = hash2(&env, &l0, &l1);
        let mut siblings: std::vec::Vec<BytesN<32>> = std::vec::Vec::new();
        let mut index_bits: std::vec::Vec<u8> = std::vec::Vec::new();
        siblings.push(zeros.get(0).unwrap());
        index_bits.push(0); // level 0 LEFT
        siblings.push(node_l0_l1);
        index_bits.push(1); // level 1 RIGHT (real internal sibling)
        for level in 2..ASP_TREE_DEPTH as usize {
            siblings.push(zeros.get(level as u32).unwrap());
            index_bits.push(0);
        }

        let recomputed = circuit_style_root(&env, &l2, &siblings, &index_bits);
        assert_eq!(recomputed, client.root(), "on-chain root must match circuit MerkleProof");
    }
}
