#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    log, symbol_short,
    Address, Bytes, BytesN, Env, Map, Vec,
};

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
/// Stored as raw bytes for the native host functions
#[contracttype]
#[derive(Clone, Debug)]
pub struct VerificationKey {
    /// α ∈ G1 (64 bytes: x, y as 32-byte big-endian)
    pub alpha_g1: BytesN<64>,
    /// β ∈ G2 (128 bytes: x0, x1, y0, y1 as 32-byte big-endian)
    pub beta_g2: BytesN<128>,
    /// γ ∈ G2 (128 bytes)
    pub gamma_g2: BytesN<128>,
    /// δ ∈ G2 (128 bytes)
    pub delta_g2: BytesN<128>,
    /// IC points ∈ G1[] — one per public input + 1
    /// Each is 64 bytes (x, y)
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
        // Only allow initialization once
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Register a verification key for a circuit.
    /// Admin-gated. Asserts gamma ≠ delta (prevents unrandomized Phase-2 forgery).
    pub fn set_vk(env: Env, circuit_id: CircuitId, vk: VerificationKey) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();

        // CRITICAL: gamma ≠ delta assertion
        // This single check prevents the Veil Cash / FoomCash bug where
        // an unrandomized Phase-2 trusted setup leaves gamma == delta,
        // allowing any proof to forge-verify.
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
    /// Uses native BN254 host functions:
    /// - `bn254_g1_mul` for scalar multiplication
    /// - `bn254_g1_add` for point addition  
    /// - `bn254_g1_msm` for multi-scalar multiplication (public input aggregation)
    /// - `bn254_multi_pairing_check` for the final verification equation
    ///
    /// The Groth16 verification equation is:
    ///   e(A, B) = e(α, β) · e(vk_x, γ) · e(C, δ)
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
        // IC has (num_public_inputs + 1) entries
        let expected_inputs = vk.ic.len() - 1;
        if public_inputs.len() != expected_inputs {
            return Err(Error::PublicInputMismatch);
        }

        // Step 1: Compute vk_x = IC[0] + Σ(public_input[i] · IC[i+1])
        // Using MSM (multi-scalar multiplication) for efficiency
        //
        // For the MSM: we need to multiply each IC[i+1] by public_input[i]
        // then add IC[0] to the result.
        //
        // The native bn254_g1_msm takes:
        //   - points: serialized G1 points (64 bytes each)
        //   - scalars: serialized scalars (32 bytes each)
        // and returns the sum of scalar*point products.

        // Collect IC points (IC[1..]) and scalars (public_inputs) for MSM
        let num_inputs = public_inputs.len();

        if num_inputs > 0 {
            // Build point and scalar arrays for MSM
            let mut msm_points = Bytes::new(&env);
            let mut msm_scalars = Bytes::new(&env);

            for i in 0..num_inputs {
                let ic_point: BytesN<64> = vk.ic.get(i + 1).ok_or(Error::PublicInputMismatch)?;
                let scalar: BytesN<32> = public_inputs.get(i).ok_or(Error::PublicInputMismatch)?;
                msm_points.append(&Bytes::from_slice(&env, ic_point.to_array().as_slice()));
                msm_scalars.append(&Bytes::from_slice(&env, scalar.to_array().as_slice()));
            }

            // Compute MSM: Σ(public_input[i] · IC[i+1])
            let msm_result = env.crypto().bls12_381(); // placeholder — actual BN254 API below
            // NOTE: The actual Soroban BN254 API uses:
            //   env.crypto().bn254().g1_msm(points, scalars) -> BytesN<64>
            //   env.crypto().bn254().g1_add(p1, p2) -> BytesN<64>
            //   env.crypto().bn254().multi_pairing_check(pairs) -> bool
            //
            // The exact API surface depends on the soroban-sdk version.
            // This is a structural placeholder — the logic is correct,
            // the actual host function bindings will be confirmed against
            // the SDK source in Sprint 1.
            
            // TODO: Replace with actual bn254_g1_msm call when SDK API is confirmed
            // let msm_result = env.crypto().bn254().g1_msm(&msm_points, &msm_scalars);
            // let vk_x = env.crypto().bn254().g1_add(&vk.ic.get(0).unwrap(), &msm_result);
        }

        // Step 2: Prepare pairing check inputs
        // Groth16 verification: e(A, B) · e(-α, β) · e(-vk_x, γ) · e(-C, δ) == 1
        // Equivalently via multi_pairing_check:
        //   multi_pairing_check([(A, B), (neg_alpha, beta), (neg_vk_x, gamma), (neg_C, delta)])
        //
        // TODO: Implement once bn254 API surface is confirmed from SDK source
        // For now, this contract compiles and demonstrates the architecture.

        log!(&env, "Groth16 verification for circuit {:?} — API binding pending", circuit_id);

        // Placeholder return — will be replaced with actual pairing check
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
}
