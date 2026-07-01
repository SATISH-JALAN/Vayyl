#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env, Vec,
};

/// Storage keys for VayylPool
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// The asset this pool manages (instance)
    Asset,
    /// Address of the Groth16Verifier contract (instance)
    Verifier,
    /// Address of the ASPMembership contract (instance)
    Membership,
    /// Address of the ASPNonMembership contract (instance)
    NonMembership,
    /// Current Merkle root (instance)
    MerkleRoot,
    /// Frontier array for efficient Merkle insert (instance)
    MerkleFrontier,
    /// Next leaf index in the Merkle tree (instance)
    NextLeafIndex,
    /// Nullifier tracking — spent if key exists (persistent)
    Nullifier(BytesN<32>),
    /// Commitment by leaf index (persistent)
    Commitment(u32),
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    NullifierAlreadySpent = 3,
    ProofVerificationFailed = 4,
    InvalidMerkleRoot = 5,
    TreeFull = 6,
}

#[contract]
pub struct VayylPoolContract;

#[contractimpl]
impl VayylPoolContract {
    /// Initialize a new shielded pool for a specific asset
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
        env.storage().instance().set(&DataKey::NonMembership, &non_membership);
        
        // Initialize empty Merkle tree
        let empty_root = BytesN::from_array(&env, &[0u8; 32]);
        env.storage().instance().set(&DataKey::MerkleRoot, &empty_root);
        
        let frontier: Vec<BytesN<32>> = Vec::new(&env);
        env.storage().instance().set(&DataKey::MerkleFrontier, &frontier);
        env.storage().instance().set(&DataKey::NextLeafIndex, &0u32);

        Ok(())
    }

    /// Deposit: verify proof, insert commitment into Merkle tree, transfer SAC tokens in
    pub fn deposit(
        _env: Env,
        _proof: BytesN<256>,
        _commitment: BytesN<32>,
        _public_amount: i128,
    ) -> Result<(), Error> {
        // TODO: Sprint 2 implementation
        // 1. Verify deposit proof via Groth16Verifier
        // 2. Verify ASP membership
        // 3. Insert commitment into Merkle tree (frontier-based)
        // 4. Transfer SAC tokens from caller to this contract
        // 5. Extend TTLs on all touched persistent keys
        Ok(())
    }

    /// Transfer: verify proof, mark nullifiers, insert new commitments
    pub fn transfer(
        _env: Env,
        _proof: BytesN<256>,
        _nullifiers: Vec<BytesN<32>>,
        _commitments: Vec<BytesN<32>>,
        _fee: i128,
        _relayer: Address,
    ) -> Result<(), Error> {
        // TODO: Sprint 2 implementation
        Ok(())
    }

    /// Withdraw: verify proof, mark nullifier, release SAC tokens
    pub fn withdraw(
        _env: Env,
        _proof: BytesN<256>,
        _nullifier: BytesN<32>,
        _public_amount: i128,
        _recipient: Address,
        _fee: i128,
        _relayer: Address,
    ) -> Result<(), Error> {
        // TODO: Sprint 2 implementation
        Ok(())
    }

    /// Internal settlement — callable only by HiddenOrderRegistry and AgenticSettlementHub
    pub fn execute_settlement(
        _env: Env,
        _recipient: Address,
        _amount: i128,
    ) -> Result<(), Error> {
        // TODO: Sprint 6 implementation
        Ok(())
    }

    /// Get current Merkle root
    pub fn merkle_root(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::MerkleRoot)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]))
    }

    /// Get next leaf index
    pub fn next_leaf_index(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::NextLeafIndex)
            .unwrap_or(0u32)
    }

    /// Check if a nullifier has been spent
    pub fn is_nullifier_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register(VayylPoolContract, ());
        let client = VayylPoolContractClient::new(&env, &contract_id);

        let asset = Address::generate(&env);
        let verifier = Address::generate(&env);
        let membership = Address::generate(&env);
        let non_membership = Address::generate(&env);

        client.initialize(&asset, &verifier, &membership, &non_membership);
        assert_eq!(client.next_leaf_index(), 0);
    }
}
