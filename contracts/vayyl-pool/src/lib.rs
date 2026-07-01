#![no_std]

use vayyl_types::{CircuitId, Groth16Proof, PositionState};
use soroban_poseidon::poseidon2_hash;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Vec,
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

        // Initialize empty tree
        env.storage().instance().set(&DataKey::TreeNextIndex, &0u32);
        let empty_frontier: Vec<BytesN<32>> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&DataKey::TreeFrontier, &empty_frontier);

        // Compute empty root (for zero leaves)
        // For simplicity in V1, we'll just set it to all zeros initially, 
        // or calculate it properly if needed.
        let zero_root = BytesN::from_array(&env, &[0; 32]);
        env.storage().instance().set(&DataKey::TreeRoot, &zero_root);

        Ok(())
    }

    /// Internal function to insert a leaf into the Merkle tree and update the root
    fn insert_leaf(env: &Env, leaf: BytesN<32>) -> Result<(), Error> {
        let mut index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TreeNextIndex)
            .unwrap_or(0);

        if index >= (1 << TREE_DEPTH) {
            return Err(Error::TreeFull);
        }

        let mut frontier: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&DataKey::TreeFrontier)
            .unwrap_or_else(|| Vec::new(&env));

        let mut current_node = leaf;
        let mut current_index = index;

        // Standard frontier insertion
        let mut new_frontier = Vec::new(&env);
        let mut added_to_frontier = false;

        // This is a simplified placeholder for the Merkle tree frontier insertion logic.
        // In a real implementation, you hash up the tree using `poseidon2_hash_2` 
        // based on the bits of the `current_index`.
        // To keep the instruction count low and meet the buildathon constraints, 
        // we'll implement a functional dummy root updater for now.
        // TODO: Full frontier logic
        new_frontier.push_back(current_node.clone());

        env.storage()
            .instance()
            .set(&DataKey::TreeNextIndex, &(index + 1));
        env.storage()
            .instance()
            .set(&DataKey::TreeFrontier, &new_frontier);
        env.storage()
            .instance()
            .set(&DataKey::TreeRoot, &current_node); // Simplified root

        Ok(())
    }

    /// Internal function to check and mark a nullifier
    fn mark_nullifier(env: &Env, nullifier: BytesN<32>) -> Result<(), Error> {
        if env
            .storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier.clone()))
        {
            return Err(Error::NullifierAlreadyUsed);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nullifier(nullifier), &true);
        // Extend TTL
        // env.storage().persistent().extend_ttl( ... );
        Ok(())
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
        // Amount is 64-bit, we pad to 32 bytes (BN254 scalar)
        let mut amount_bytes = [0u8; 32];
        amount_bytes[24..32].copy_from_slice(&public_amount.to_be_bytes()[8..16]); // assuming positive i128
        public_inputs.push_back(BytesN::from_array(&env, &amount_bytes));
        public_inputs.push_back(commitment.clone());
        public_inputs.push_back(asp_root);

        let is_valid = verifier_client.verify(&CircuitId::Deposit, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 3. Insert commitment into the Merkle tree
        Self::insert_leaf(&env, commitment)?;

        Ok(())
    }

    /// Transfer shielded funds
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

        // 1. Mark Nullifiers
        Self::mark_nullifier(&env, nullifier1.clone())?;
        Self::mark_nullifier(&env, nullifier2.clone())?;

        // 2. Verify ZK Proof for Transfer
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

        // Meta hash (e.g. hash of relayer address)
        let mut meta_bytes = [0u8; 32];
        // In reality we would compute poseidon2_hash of relayer address string or similar.
        // Using a dummy for now.
        public_inputs.push_back(BytesN::from_array(&env, &meta_bytes));

        let is_valid = verifier_client.verify(&CircuitId::Transfer, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 3. Insert new commitments into the Merkle tree
        Self::insert_leaf(&env, commitment1)?;
        Self::insert_leaf(&env, commitment2)?;

        // 4. Pay Relayer
        if fee > 0 {
            let token_client = token::Client::new(&env, &asset);
            token_client.transfer(&env.current_contract_address(), &relayer, &fee);
        }

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

        // 1. Mark Nullifier
        Self::mark_nullifier(&env, nullifier.clone())?;

        // 2. Verify ZK Proof for Withdraw
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

        let mut binding_bytes = [0u8; 32];
        public_inputs.push_back(BytesN::from_array(&env, &binding_bytes));

        let is_valid = verifier_client.verify(&CircuitId::Withdraw, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::InvalidProof);
        }

        // 3. Transfer tokens
        let token_client = token::Client::new(&env, &asset);
        if public_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &recipient, &public_amount);
        }
        if fee > 0 {
            token_client.transfer(&env.current_contract_address(), &relayer, &fee);
        }

        Ok(())
    }
}
