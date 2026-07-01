#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Fr},
    log,
    Address, BytesN, Env, Vec,
};
use core::ops::Neg;

/// Circuit identifiers for different proof types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CircuitId {
    Deposit,
    Transfer,
    Withdraw,
    PositionOpen,
    PositionHealth,
    PositionClose,
    LiquidationHeartbeat,
    HiddenOrderTrigger,
    MultiLegBasket,
    AspMembership,
    AspNonMembership,
    SealedOrder,
}

/// Storage keys
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// Verification key for a specific circuit
    Vk(CircuitId),
}

/// Verification key components for Groth16/BN254
/// Points stored as raw bytes in Ethereum-compatible uncompressed format:
///   G1: 64 bytes = be(x) || be(y)
///   G2: 128 bytes = be(x_c1) || be(x_c0) || be(y_c1) || be(y_c0)
#[contracttype]
#[derive(Clone, Debug)]
pub struct VerificationKey {
    /// α ∈ G1 (64 bytes)
    pub alpha_g1: BytesN<64>,
    /// β ∈ G2 (128 bytes)
    pub beta_g2: BytesN<128>,
    /// γ ∈ G2 (128 bytes)
    pub gamma_g2: BytesN<128>,
    /// δ ∈ G2 (128 bytes)
    pub delta_g2: BytesN<128>,
    /// IC points ∈ G1[] — one per public input + 1
    /// Each is 64 bytes
    pub ic: Vec<BytesN<64>>,
}

/// Proof components for Groth16/BN254
#[contracttype]
#[derive(Clone, Debug)]
pub struct Groth16Proof {
    /// A ∈ G1 (64 bytes)
    pub a: BytesN<64>,
    /// B ∈ G2 (128 bytes)
    pub b: BytesN<128>,
    /// C ∈ G1 (64 bytes)
    pub c: BytesN<64>,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// Caller is not the contract admin
    Unauthorized = 1,
    /// No verification key registered for this circuit
    VkNotFound = 2,
    /// Verification key gamma == delta (Veil Cash / FoomCash bug)
    GammaEqualsDelta = 3,
    /// Public input count doesn't match VK's IC length - 1
    PublicInputMismatch = 4,
    /// Proof verification failed (pairing check returned false)
    ProofInvalid = 5,
    /// Invalid point encoding
    InvalidEncoding = 6,
}

#[contract]
pub struct Groth16VerifierContract;

#[contractimpl]
impl Groth16VerifierContract {
    /// Initialize the verifier with an admin address
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Register a verification key for a circuit.
    /// Admin-gated. Asserts gamma ≠ delta (prevents Veil Cash / FoomCash forgery bug).
    pub fn set_vk(env: Env, circuit_id: CircuitId, vk: VerificationKey) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        // CRITICAL: gamma ≠ delta assertion
        if vk.gamma_g2 == vk.delta_g2 {
            log!(&env, "SECURITY: Rejected VK with gamma == delta for circuit {:?}", circuit_id);
            return Err(Error::GammaEqualsDelta);
        }

        // IC must have at least 1 entry (IC[0] is the base point)
        if vk.ic.is_empty() {
            return Err(Error::PublicInputMismatch);
        }

        env.storage()
            .instance()
            .set(&DataKey::Vk(circuit_id.clone()), &vk);

        log!(&env, "VK registered for circuit {:?}, {} public inputs",
             circuit_id, vk.ic.len() - 1);

        Ok(())
    }

    /// Verify a Groth16 proof against registered VK for the given circuit.
    ///
    /// Uses native BN254 host functions via `env.crypto().bn254()`:
    /// - `g1_mul` for scalar multiplication
    /// - `g1_add` for point addition
    /// - `Neg` trait on `Bn254G1Affine` for point negation
    /// - `pairing_check` for the final verification equation
    ///
    /// The Groth16 verification equation:
    ///   e(A, B) · e(-α, β) · e(-vk_x, γ) · e(-C, δ) == 1
    ///
    /// where vk_x = IC[0] + Σ(public_input[i] · IC[i+1])
    pub fn verify(
        env: Env,
        circuit_id: CircuitId,
        proof: Groth16Proof,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<bool, Error> {
        let vk: VerificationKey = env
            .storage()
            .instance()
            .get(&DataKey::Vk(circuit_id.clone()))
            .ok_or(Error::VkNotFound)?;

        // Check public input count matches VK
        let expected_inputs = vk.ic.len() - 1;
        if public_inputs.len() != expected_inputs {
            return Err(Error::PublicInputMismatch);
        }

        let bn254 = env.crypto().bn254();

        // Step 1: Compute vk_x = IC[0] + Σ(public_input[i] · IC[i+1])
        let mut vk_x = Bn254G1Affine::from_bytes(vk.ic.get(0).unwrap());

        for i in 0..public_inputs.len() {
            let ic_point = Bn254G1Affine::from_bytes(
                vk.ic.get(i + 1).ok_or(Error::PublicInputMismatch)?
            );
            let scalar = Fr::from_bytes(
                public_inputs.get(i).ok_or(Error::PublicInputMismatch)?
            );

            // scalar * IC[i+1]
            let product = bn254.g1_mul(&ic_point, &scalar);
            // accumulate: vk_x = vk_x + product
            vk_x = bn254.g1_add(&vk_x, &product);
        }

        // Step 2: Prepare pairing check inputs
        // Groth16: e(A, B) · e(-α, β) · e(-vk_x, γ) · e(-C, δ) == 1

        let proof_a = Bn254G1Affine::from_bytes(proof.a);
        let proof_b = Bn254G2Affine::from_bytes(proof.b);
        let proof_c = Bn254G1Affine::from_bytes(proof.c);

        let alpha_g1 = Bn254G1Affine::from_bytes(vk.alpha_g1);
        let beta_g2 = Bn254G2Affine::from_bytes(vk.beta_g2);
        let gamma_g2 = Bn254G2Affine::from_bytes(vk.gamma_g2);
        let delta_g2 = Bn254G2Affine::from_bytes(vk.delta_g2);

        // Negate G1 points using the Neg trait: -P = (x, p - y)
        let neg_alpha = alpha_g1.neg();
        let neg_vk_x = vk_x.neg();
        let neg_c = proof_c.neg();

        // Build pairing check vectors
        let mut g1_vec: Vec<Bn254G1Affine> = Vec::new(&env);
        let mut g2_vec: Vec<Bn254G2Affine> = Vec::new(&env);

        g1_vec.push_back(proof_a);       // A
        g2_vec.push_back(proof_b);       // B

        g1_vec.push_back(neg_alpha);     // -α
        g2_vec.push_back(beta_g2);       // β

        g1_vec.push_back(neg_vk_x);     // -vk_x
        g2_vec.push_back(gamma_g2);      // γ

        g1_vec.push_back(neg_c);         // -C
        g2_vec.push_back(delta_g2);      // δ

        // Step 3: Execute pairing check
        let result = bn254.pairing_check(g1_vec, g2_vec);

        if !result {
            log!(&env, "Groth16 verification FAILED for circuit {:?}", circuit_id);
            return Err(Error::ProofInvalid);
        }

        log!(&env, "Groth16 verification PASSED for circuit {:?}", circuit_id);
        Ok(true)
    }

    /// Get the number of public inputs expected for a circuit
    pub fn get_public_input_count(env: Env, circuit_id: CircuitId) -> Result<u32, Error> {
        let vk: VerificationKey = env
            .storage()
            .instance()
            .get(&DataKey::Vk(circuit_id))
            .ok_or(Error::VkNotFound)?;
        Ok(vk.ic.len() - 1)
    }

    /// Check if a VK is registered for a circuit
    pub fn has_vk(env: Env, circuit_id: CircuitId) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::Vk(circuit_id))
    }

    /// Get the admin address
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register(Groth16VerifierContract, ());
        let client = Groth16VerifierContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);
        assert_eq!(client.admin(), admin);
    }

    #[test]
    fn test_gamma_equals_delta_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(Groth16VerifierContract, ());
        let client = Groth16VerifierContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        // Create a VK where gamma == delta (the bug condition)
        let same_point = BytesN::from_array(&env, &[1u8; 128]);
        let vk = VerificationKey {
            alpha_g1: BytesN::from_array(&env, &[1u8; 64]),
            beta_g2: BytesN::from_array(&env, &[2u8; 128]),
            gamma_g2: same_point.clone(),
            delta_g2: same_point,  // gamma == delta!
            ic: Vec::from_slice(&env, &[BytesN::from_array(&env, &[3u8; 64])]),
        };

        // Should be rejected
        let result = client.try_set_vk(&CircuitId::Deposit, &vk);
        assert!(result.is_err());
    }

    #[test]
    fn test_has_vk_false_initially() {
        let env = Env::default();
        let contract_id = env.register(Groth16VerifierContract, ());
        let client = Groth16VerifierContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert!(!client.has_vk(&CircuitId::Deposit));
    }
}
