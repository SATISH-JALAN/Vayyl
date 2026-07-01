#![no_std]

use vayyl_types::{CircuitId, Groth16Proof};
use soroban_poseidon::poseidon2_hash;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, log, token, Address, BytesN, Env, Vec,
};

#[soroban_sdk::contractclient(name = "Groth16VerifierClient")]
pub trait Groth16VerifierInterface {
    fn verify(env: Env, circuit_id: CircuitId, proof: Groth16Proof, public_inputs: Vec<BytesN<32>>) -> Result<bool, soroban_sdk::Error>;
}

pub const TREE_DEPTH: u32 = 20;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Asset,
    Verifier,
    Membership,
    NonMembership,
    TreeNextIndex,
    TreeFrontier,
    TreeRoot,
    TreeZeros,
    Nullifier(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidProof = 3,
    NullifierAlreadyUsed = 4,
    TreeFull = 5,
}

#[contract]
pub struct VayylPool;

/// Compute a Poseidon2 hash of two 32-byte inputs, returning a 32-byte output.
/// This wraps the native Soroban `poseidon2_hash` host function.
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
impl VayylPool {
    /// Initialize the Vayyl Pool with the underlying asset and external contract references
    pub fn initialize(
        env: Env,
        asset: Address,
        verifier: Address,
        membership: Address,
        non_membership: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Asset) {
            return Err(Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Asset, &asset);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage().instance().set(&DataKey::Membership, &membership);
        env.storage()
            .instance()
            .set(&DataKey::NonMembership, &non_membership);

        // Initialize tree state
        env.storage().instance().set(&DataKey::TreeNextIndex, &0u32);

        // Precompute zero hashes for each level of the tree.
        // zeros[0] = 0 (empty leaf)
        // zeros[i] = Poseidon2(zeros[i-1], zeros[i-1])
        let mut zeros: Vec<BytesN<32>> = Vec::new(&env);
        let zero_leaf = BytesN::from_array(&env, &[0u8; 32]);
        zeros.push_back(zero_leaf.clone());

        let mut current_zero = zero_leaf;
        for _ in 1..=TREE_DEPTH {
            current_zero = hash2(&env, &current_zero, &current_zero);
            zeros.push_back(current_zero.clone());
        }
        env.storage().persistent().set(&DataKey::TreeZeros, &zeros);

        // Initialize empty frontier (TREE_DEPTH entries, all unset)
        let empty_frontier: Vec<BytesN<32>> = Vec::new(&env);
        env.storage()
            .persistent()
            .set(&DataKey::TreeFrontier, &empty_frontier);

        // Initial root = zeros[TREE_DEPTH] (root of a completely empty tree)
        env.storage()
            .instance()
            .set(&DataKey::TreeRoot, &current_zero);

        log!(&env, "VayylPool initialized. Empty root computed at depth {}", TREE_DEPTH);

        Ok(())
    }

    /// Insert a leaf into the Merkle tree using frontier-based insertion.
    ///
    /// The frontier stores the "left-most unsettled" node at each level.
    /// When a new leaf arrives:
    /// - Walk up the tree from the leaf level.
    /// - At each level, if the current index bit is 0, this leaf is a LEFT child:
    ///   store it in the frontier and hash with the zero-sibling from the right.
    /// - If the current index bit is 1, this leaf is a RIGHT child:
    ///   pop the frontier value (the left sibling) and hash together.
    /// - Continue up to the root.
    fn insert_leaf(env: &Env, leaf: BytesN<32>) -> Result<BytesN<32>, Error> {
        let index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TreeNextIndex)
            .unwrap_or(0);

        if index >= (1u32 << TREE_DEPTH) {
            return Err(Error::TreeFull);
        }

        let zeros: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::TreeZeros)
            .unwrap();

        let mut frontier: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::TreeFrontier)
            .unwrap_or_else(|| Vec::new(env));

        // Ensure frontier has TREE_DEPTH slots
        while frontier.len() < TREE_DEPTH {
            frontier.push_back(BytesN::from_array(env, &[0u8; 32]));
        }

        let mut current_hash = leaf;
        let mut current_index = index;

        for level in 0..TREE_DEPTH {
            if current_index & 1 == 0 {
                // Current node is a LEFT child: store in frontier, pair with zero
                frontier.set(level, current_hash.clone());
                current_hash = hash2(env, &current_hash, &zeros.get(level).unwrap());
            } else {
                // Current node is a RIGHT child: pair with frontier (left sibling)
                let left = frontier.get(level).unwrap();
                current_hash = hash2(env, &left, &current_hash);
            }
            current_index >>= 1;
        }

        // current_hash is now the new root
        let new_root = current_hash;

        env.storage()
            .instance()
            .set(&DataKey::TreeNextIndex, &(index + 1));
        env.storage()
            .persistent()
            .set(&DataKey::TreeFrontier, &frontier);
        env.storage()
            .instance()
            .set(&DataKey::TreeRoot, &new_root);

        // Extend TTL for persistent data
        env.storage().persistent().extend_ttl(
            &DataKey::TreeFrontier,
            50000,
            100000,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::TreeZeros,
            50000,
            100000,
        );

        log!(env, "Leaf inserted at index {}. New root computed.", index);

        Ok(new_root)
    }

    /// Internal function to check and mark a nullifier
    fn mark_nullifier(env: &Env, nullifier: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::NullifierAlreadyUsed);
        }
        env.storage().persistent().set(&key, &true);
        // Extend TTL — nullifiers must persist forever to prevent double-spend
        env.storage().persistent().extend_ttl(&key, 50000, 100000);
        Ok(())
    }

    /// Compute a binding hash for metadata (relayer address, etc.)
    /// This produces a 32-byte hash that binds the proof to specific transaction metadata,
    /// preventing proof replay/front-running attacks.
    fn compute_meta_hash(env: &Env, relayer: &Address, fee: i128) -> BytesN<32> {
        use soroban_sdk::xdr::ToXdr;
        let mut bytes = soroban_sdk::Bytes::new(env);
        bytes.append(&relayer.to_xdr(env));
        
        let mut fee_bytes = [0u8; 16];
        fee_bytes[0..16].copy_from_slice(&fee.to_be_bytes());
        bytes.append(&soroban_sdk::Bytes::from_array(env, &fee_bytes));
        
        let sha_hash = env.crypto().sha256(&bytes);
        
        // Poseidon2 expects field elements. A 32-byte SHA256 hash might be >= BN254 prime.
        // We clear the top 3 bits to ensure it fits in BN254 scalar field.
        let mut hash_bytes = sha_hash.to_array();
        hash_bytes[0] &= 0x1F;
        
        BytesN::from_array(env, &hash_bytes)
    }

    /// Compute withdraw binding hash from recipient address
    /// Binds the proof to a specific withdrawal destination
    fn compute_withdraw_binding(env: &Env, recipient: &Address, amount: i128) -> BytesN<32> {
        use soroban_sdk::xdr::ToXdr;
        let mut bytes = soroban_sdk::Bytes::new(env);
        bytes.append(&recipient.to_xdr(env));
        
        let mut amt_bytes = [0u8; 16];
        amt_bytes[0..16].copy_from_slice(&amount.to_be_bytes());
        bytes.append(&soroban_sdk::Bytes::from_array(env, &amt_bytes));
        
        let sha_hash = env.crypto().sha256(&bytes);
        
        // Clear top 3 bits to fit in BN254 scalar field
        let mut hash_bytes = sha_hash.to_array();
        hash_bytes[0] &= 0x1F;
        
        BytesN::from_array(env, &hash_bytes)
    }

    /// Deposit public funds into the shielded pool
    pub fn deposit(
        env: Env,
        depositor: Address,
        proof: Groth16Proof,
        commitment: BytesN<32>,
        public_amount: i128,
        asp_root: BytesN<32>,
    ) -> Result<(), Error> {
        depositor.require_auth();

        let asset: Address = env.storage().instance().get(&DataKey::Asset).ok_or(Error::NotInitialized)?;
        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).unwrap();

        // 1. Transfer tokens from depositor to the pool
        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&depositor, &env.current_contract_address(), &public_amount);

        // 2. Verify ZK Proof for Deposit
        let verifier_client = Groth16VerifierClient::new(&env, &verifier);
        
        // Build public inputs: [amount, commitment, asp_root]
        let mut public_inputs = Vec::new(&env);
        let mut amount_bytes = [0u8; 32];
        amount_bytes[24..32].copy_from_slice(&public_amount.to_be_bytes()[8..16]);
        public_inputs.push_back(BytesN::from_array(&env, &amount_bytes));
        public_inputs.push_back(commitment.clone());
        public_inputs.push_back(asp_root);

        let is_valid = verifier_client.verify(&CircuitId::Deposit, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 3. Insert commitment into the Merkle tree
        Self::insert_leaf(&env, commitment)?;

        log!(&env, "Deposit of {} completed successfully", public_amount);

        Ok(())
    }

    /// Transfer shielded funds (2-in / 2-out)
    pub fn transfer(
        env: Env,
        proof: Groth16Proof,
        nullifier1: BytesN<32>,
        nullifier2: BytesN<32>,
        commitment1: BytesN<32>,
        commitment2: BytesN<32>,
        fee: i128,
        relayer: Address,
    ) -> Result<(), Error> {
        let asset: Address = env.storage().instance().get(&DataKey::Asset).ok_or(Error::NotInitialized)?;
        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).unwrap();
        let root: BytesN<32> = env.storage().instance().get(&DataKey::TreeRoot).unwrap();

        // 1. Mark Nullifiers (prevents double-spend)
        Self::mark_nullifier(&env, nullifier1.clone())?;
        Self::mark_nullifier(&env, nullifier2.clone())?;

        // 2. Compute meta_hash binding proof to this specific relayer + fee
        let meta_hash = Self::compute_meta_hash(&env, &relayer, fee);

        // 3. Verify ZK Proof for Transfer
        let verifier_client = Groth16VerifierClient::new(&env, &verifier);
        
        // Build public inputs: [root, nullifier1, nullifier2, commitment1, commitment2, fee, meta_hash]
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(root);
        public_inputs.push_back(nullifier1);
        public_inputs.push_back(nullifier2);
        public_inputs.push_back(commitment1.clone());
        public_inputs.push_back(commitment2.clone());
        
        let mut fee_bytes = [0u8; 32];
        fee_bytes[24..32].copy_from_slice(&fee.to_be_bytes()[8..16]);
        public_inputs.push_back(BytesN::from_array(&env, &fee_bytes));

        public_inputs.push_back(meta_hash);

        let is_valid = verifier_client.verify(&CircuitId::Transfer, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 4. Insert new commitments into the Merkle tree
        Self::insert_leaf(&env, commitment1)?;
        Self::insert_leaf(&env, commitment2)?;

        // 5. Pay Relayer fee from the pool's held tokens
        if fee > 0 {
            let token_client = token::Client::new(&env, &asset);
            token_client.transfer(&env.current_contract_address(), &relayer, &fee);
        }

        log!(&env, "Transfer completed. 2 new commitments inserted.");

        Ok(())
    }

    /// Withdraw funds from the shielded pool to a public address
    pub fn withdraw(
        env: Env,
        proof: Groth16Proof,
        nullifier: BytesN<32>,
        public_amount: i128,
        recipient: Address,
        fee: i128,
        relayer: Address,
    ) -> Result<(), Error> {
        let asset: Address = env.storage().instance().get(&DataKey::Asset).ok_or(Error::NotInitialized)?;
        let verifier: Address = env.storage().instance().get(&DataKey::Verifier).unwrap();
        let root: BytesN<32> = env.storage().instance().get(&DataKey::TreeRoot).unwrap();

        // 1. Mark Nullifier (prevents double-spend)
        Self::mark_nullifier(&env, nullifier.clone())?;

        // 2. Compute withdraw_binding = Poseidon2(recipient, amount)
        let withdraw_binding = Self::compute_withdraw_binding(&env, &recipient, public_amount);

        // 3. Verify ZK Proof for Withdraw
        let verifier_client = Groth16VerifierClient::new(&env, &verifier);
        
        // Build public inputs: [root, nullifier, public_amount, fee, withdraw_binding]
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(root);
        public_inputs.push_back(nullifier);
        
        let mut amt_bytes = [0u8; 32];
        amt_bytes[24..32].copy_from_slice(&public_amount.to_be_bytes()[8..16]);
        public_inputs.push_back(BytesN::from_array(&env, &amt_bytes));

        let mut fee_bytes = [0u8; 32];
        fee_bytes[24..32].copy_from_slice(&fee.to_be_bytes()[8..16]);
        public_inputs.push_back(BytesN::from_array(&env, &fee_bytes));

        public_inputs.push_back(withdraw_binding);

        let is_valid = verifier_client.verify(&CircuitId::Withdraw, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 4. Transfer tokens to recipient and relayer
        let token_client = token::Client::new(&env, &asset);
        if public_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &recipient, &public_amount);
        }
        if fee > 0 {
            token_client.transfer(&env.current_contract_address(), &relayer, &fee);
        }

        log!(&env, "Withdraw of {} completed to recipient.", public_amount);

        Ok(())
    }

    /// Get the current Merkle root
    pub fn get_root(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::TreeRoot)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]))
    }

    /// Get the current leaf count
    pub fn get_leaf_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TreeNextIndex)
            .unwrap_or(0)
    }
}
