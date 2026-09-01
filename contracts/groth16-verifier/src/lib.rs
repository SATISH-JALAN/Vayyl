#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Bn254Fr},
    log,
    Address, BytesN, Env, Vec,
};
use core::ops::Neg;

use vayyl_types::{CircuitId, Groth16Proof, VerificationKey};

/// Storage keys
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// Verification key for a specific circuit
    Vk(CircuitId),
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
            let scalar = Bn254Fr::from_bytes(
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

        // M1: return Ok(false) instead of trapping so callers using the non-`try`
        // client get a boolean they can branch on. A failed pairing is a normal
        // "this proof is invalid" outcome, not a contract error — trapping here
        // would abort the whole tx and make the pool's `if !is_valid` dead code.
        if !result {
            log!(&env, "Groth16 verification FAILED for circuit {:?}", circuit_id);
            return Ok(false);
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

    /// Upgrade the contract's WASM code in place (admin-gated).
    ///
    /// Swaps the code this same address runs while keeping all stored state
    /// (admin + every registered VK). Without this, a verifier bug fix would
    /// require a fresh deploy and re-registration of every circuit's VK.
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
mod real_proof_fixture;

#[cfg(test)]
mod real_transfer_fixture;

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use crate::real_proof_fixture as fixture;
    use crate::real_transfer_fixture as transfer_fixture;

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

    #[contract]
    pub struct CallerContract;

    #[contractimpl]
    impl CallerContract {
        pub fn call_verifier(
            env: Env,
            verifier_id: Address,
            circuit_id: CircuitId,
            public_inputs: Vec<BytesN<32>>,
            proof: Groth16Proof,
        ) -> bool {
            let client = Groth16VerifierContractClient::new(&env, &verifier_id);
            client.verify(&circuit_id, &proof, &public_inputs)
        }
    }

    #[test]
    #[should_panic(expected = "Error(Crypto, InvalidInput)")]
    fn test_malformed_points_are_rejected_at_deserialization() {
        // All-zero bytes are not a valid curve point encoding, so the host
        // rejects them inside Bn254G1Affine::from_bytes — BEFORE any pairing
        // runs. This test pins that early-rejection behaviour and nothing more;
        // real pairing coverage lives in the fixture-backed tests below.
        let env = Env::default();
        env.mock_all_auths();

        let verifier_id = env.register(Groth16VerifierContract, ());
        let verifier_client = Groth16VerifierContractClient::new(&env, &verifier_id);

        let admin = Address::generate(&env);
        verifier_client.initialize(&admin);

        let vk = VerificationKey {
            alpha_g1: BytesN::from_array(&env, &[0u8; 64]),
            beta_g2: BytesN::from_array(&env, &[0u8; 128]),
            gamma_g2: BytesN::from_array(&env, &[0u8; 128]),
            delta_g2: BytesN::from_array(&env, &[1u8; 128]), // gamma != delta
            ic: Vec::from_slice(&env, &[
                BytesN::from_array(&env, &[0u8; 64]),
                BytesN::from_array(&env, &[0u8; 64])
            ]),
        };
        verifier_client.set_vk(&CircuitId::Deposit, &vk);

        let caller_id = env.register(CallerContract, ());
        let caller_client = CallerContractClient::new(&env, &caller_id);

        let proof = Groth16Proof {
            a: BytesN::from_array(&env, &[0u8; 64]),
            b: BytesN::from_array(&env, &[0u8; 128]),
            c: BytesN::from_array(&env, &[0u8; 64]),
        };

        let public_inputs = Vec::from_slice(&env, &[BytesN::from_array(&env, &[0u8; 32])]);
        caller_client.call_verifier(&verifier_id, &CircuitId::Deposit, &public_inputs, &proof);
    }

    // ---- Real Groth16 proof tests -----------------------------------------
    //
    // Everything below runs an ACTUAL pairing over a real withdraw_v2 proof
    // generated by snarkjs (see circuits/scripts/gen_verifier_fixture.mjs).
    // Before Sprint 1 nothing in this repo ever reached the pairing check.

    fn hex_bytes<const N: usize>(s: &str) -> [u8; N] {
        assert_eq!(s.len(), N * 2, "fixture hex has wrong length");
        let raw = s.as_bytes();
        let mut out = [0u8; N];
        let nib = |c: u8| -> u8 {
            match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => panic!("non-hex character in fixture"),
            }
        };
        let mut i = 0;
        while i < N {
            out[i] = (nib(raw[i * 2]) << 4) | nib(raw[i * 2 + 1]);
            i += 1;
        }
        out
    }

    // Fixture-agnostic constructors: the withdraw_v2 and transfer_v2 fixtures
    // expose identical const names, so both circuits share this plumbing.
    fn vk_from(
        env: &Env,
        alpha: &str,
        beta: &str,
        gamma: &str,
        delta: &str,
        ic_entries: &[&str],
    ) -> VerificationKey {
        let mut ic = Vec::new(env);
        for entry in ic_entries.iter() {
            ic.push_back(BytesN::from_array(env, &hex_bytes::<64>(entry)));
        }
        VerificationKey {
            alpha_g1: BytesN::from_array(env, &hex_bytes::<64>(alpha)),
            beta_g2: BytesN::from_array(env, &hex_bytes::<128>(beta)),
            gamma_g2: BytesN::from_array(env, &hex_bytes::<128>(gamma)),
            delta_g2: BytesN::from_array(env, &hex_bytes::<128>(delta)),
            ic,
        }
    }

    fn proof_from(env: &Env, a: &str, b: &str, c: &str) -> Groth16Proof {
        Groth16Proof {
            a: BytesN::from_array(env, &hex_bytes::<64>(a)),
            b: BytesN::from_array(env, &hex_bytes::<128>(b)),
            c: BytesN::from_array(env, &hex_bytes::<64>(c)),
        }
    }

    fn public_inputs_from(env: &Env, inputs: &[&str]) -> Vec<BytesN<32>> {
        let mut v = Vec::new(env);
        for input in inputs.iter() {
            v.push_back(BytesN::from_array(env, &hex_bytes::<32>(input)));
        }
        v
    }

    fn real_vk(env: &Env) -> VerificationKey {
        vk_from(
            env,
            fixture::VK_ALPHA_G1,
            fixture::VK_BETA_G2,
            fixture::VK_GAMMA_G2,
            fixture::VK_DELTA_G2,
            &fixture::VK_IC,
        )
    }

    fn real_proof(env: &Env) -> Groth16Proof {
        proof_from(env, fixture::PROOF_A, fixture::PROOF_B, fixture::PROOF_C)
    }

    fn real_public_inputs(env: &Env) -> Vec<BytesN<32>> {
        public_inputs_from(env, &fixture::PUBLIC_INPUTS)
    }

    fn transfer_vk(env: &Env) -> VerificationKey {
        vk_from(
            env,
            transfer_fixture::VK_ALPHA_G1,
            transfer_fixture::VK_BETA_G2,
            transfer_fixture::VK_GAMMA_G2,
            transfer_fixture::VK_DELTA_G2,
            &transfer_fixture::VK_IC,
        )
    }

    fn transfer_proof(env: &Env) -> Groth16Proof {
        proof_from(
            env,
            transfer_fixture::PROOF_A,
            transfer_fixture::PROOF_B,
            transfer_fixture::PROOF_C,
        )
    }

    fn transfer_public_inputs(env: &Env) -> Vec<BytesN<32>> {
        public_inputs_from(env, &transfer_fixture::PUBLIC_INPUTS)
    }

    /// Registers the real transfer_v2 VK under CircuitId::Transfer.
    fn verifier_with_transfer_vk(env: &Env) -> Groth16VerifierContractClient<'static> {
        env.mock_all_auths();
        let verifier_id = env.register(Groth16VerifierContract, ());
        let client = Groth16VerifierContractClient::new(env, &verifier_id);
        client.initialize(&Address::generate(env));
        client.set_vk(&CircuitId::Transfer, &transfer_vk(env));
        client
    }

    #[test]
    fn real_transfer_proof_verifies_true() {
        let env = Env::default();
        let client = verifier_with_transfer_vk(&env);

        // Five public inputs: [root, nullifier, commitment_out, eph_x, eph_y].
        // This is the pin for the whole transfer path — if the circuit's signal
        // order and the pool's Vec order ever diverge, every transfer fails
        // on-chain as an opaque InvalidProof with nothing to point at.
        assert_eq!(transfer_public_inputs(&env).len(), 5);
        assert!(
            client.verify(
                &CircuitId::Transfer,
                &transfer_proof(&env),
                &transfer_public_inputs(&env)
            ),
            "a genuine transfer_v2 proof must verify on-chain",
        );
    }

    #[test]
    fn mutated_transfer_output_commitment_verifies_false() {
        let env = Env::default();
        let client = verifier_with_transfer_vk(&env);

        // Slot 2 is commitment_out — the field that decides who ends up owning
        // the note. A relayer redirecting the payment must be rejected.
        let mut inputs = transfer_public_inputs(&env);
        let mut tampered = inputs.get(2).unwrap().to_array();
        tampered[31] ^= 0x01;
        inputs.set(2, BytesN::from_array(&env, &tampered));

        assert!(
            !client.verify(&CircuitId::Transfer, &transfer_proof(&env), &inputs),
            "a redirected transfer output must not verify",
        );
    }

    #[test]
    fn mutated_transfer_ephemeral_point_verifies_false() {
        let env = Env::default();
        let client = verifier_with_transfer_vk(&env);

        // Slot 3 is ephemeral_x. Corrupting it would leave the recipient unable
        // to ever derive the note's blindness, destroying the funds; binding it
        // into the proof is what makes that tampering detectable.
        let mut inputs = transfer_public_inputs(&env);
        let mut tampered = inputs.get(3).unwrap().to_array();
        tampered[31] ^= 0x01;
        inputs.set(3, BytesN::from_array(&env, &tampered));

        assert!(
            !client.verify(&CircuitId::Transfer, &transfer_proof(&env), &inputs),
            "a tampered ephemeral point must not verify",
        );
    }

    #[test]
    fn transfer_proof_under_withdraw_vk_verifies_false() {
        let env = Env::default();
        env.mock_all_auths();
        let verifier_id = env.register(Groth16VerifierContract, ());
        let client = Groth16VerifierContractClient::new(&env, &verifier_id);
        client.initialize(&Address::generate(&env));
        // Both VKs registered, as they are on the live verifier.
        client.set_vk(&CircuitId::Withdraw, &real_vk(&env));
        client.set_vk(&CircuitId::Transfer, &transfer_vk(&env));

        // A transfer proof presented against the withdraw slot must fail. The
        // input counts differ (5 vs 3), so this also pins that the verifier
        // rejects on arity rather than reading past the end of the IC vector.
        let wrong = client.try_verify(
            &CircuitId::Withdraw,
            &transfer_proof(&env),
            &transfer_public_inputs(&env),
        );
        assert!(
            matches!(wrong, Err(_) | Ok(Ok(false))),
            "a transfer proof must not verify against the withdraw VK",
        );
    }

    /// Registers the real withdraw_v2 VK and returns a ready client.
    fn verifier_with_real_vk(env: &Env) -> Groth16VerifierContractClient<'static> {
        env.mock_all_auths();
        let verifier_id = env.register(Groth16VerifierContract, ());
        let client = Groth16VerifierContractClient::new(env, &verifier_id);
        client.initialize(&Address::generate(env));
        client.set_vk(&CircuitId::Withdraw, &real_vk(env));
        client
    }

    #[test]
    fn real_proof_verifies_true() {
        let env = Env::default();
        let client = verifier_with_real_vk(&env);

        assert!(
            client.verify(&CircuitId::Withdraw, &real_proof(&env), &real_public_inputs(&env)),
            "a genuine withdraw_v2 proof must verify on-chain",
        );
    }

    #[test]
    fn mutated_public_input_verifies_false() {
        let env = Env::default();
        let client = verifier_with_real_vk(&env);

        // Corrupt the Merkle root (public input 0) by one bit.
        let mut inputs = real_public_inputs(&env);
        let mut root = hex_bytes::<32>(fixture::PUBLIC_INPUTS[0]);
        root[31] ^= 0x01;
        inputs.set(0, BytesN::from_array(&env, &root));

        assert!(
            !client.verify(&CircuitId::Withdraw, &real_proof(&env), &inputs),
            "a proof must not verify against a public input it was not generated for",
        );
    }

    /// The on-chain half of the F1 double-spend defence.
    ///
    /// `nullifier = Poseidon2(commitment, privKey)` is public input 1. An
    /// attacker holding one note wants a second, different nullifier for it so
    /// the pool's nullifier set does not catch the reuse. Two things stop that:
    /// the circuit refuses to produce a witness for a non-canonical privKey
    /// (see circuits/scripts/payment_circuits_test.mjs), and — proven here — a
    /// proof cannot simply be re-pointed at a substituted nullifier.
    #[test]
    fn substituted_nullifier_verifies_false() {
        let env = Env::default();
        let client = verifier_with_real_vk(&env);

        let mut inputs = real_public_inputs(&env);
        let mut nullifier = hex_bytes::<32>(fixture::PUBLIC_INPUTS[1]);
        nullifier[31] ^= 0x01; // any different nullifier = a second spend
        inputs.set(1, BytesN::from_array(&env, &nullifier));

        assert!(
            !client.verify(&CircuitId::Withdraw, &real_proof(&env), &inputs),
            "reusing a note under a different nullifier must be rejected",
        );
    }

    #[test]
    fn mutated_withdraw_binding_verifies_false() {
        let env = Env::default();
        let client = verifier_with_real_vk(&env);

        // The recipient binding (public input 2) is the front-running defence:
        // re-targeting a proof at a different recipient must not verify.
        let mut inputs = real_public_inputs(&env);
        let mut binding = hex_bytes::<32>(fixture::PUBLIC_INPUTS[2]);
        binding[31] ^= 0x01;
        inputs.set(2, BytesN::from_array(&env, &binding));

        assert!(
            !client.verify(&CircuitId::Withdraw, &real_proof(&env), &inputs),
            "a proof must be bound to its recipient",
        );
    }

    #[test]
    fn tampered_proof_verifies_false() {
        let env = Env::default();
        let client = verifier_with_real_vk(&env);

        // Swap A and C: both are valid curve points, so this exercises the
        // pairing check itself rather than point deserialization.
        let proof = real_proof(&env);
        let swapped = Groth16Proof { a: proof.c.clone(), b: proof.b.clone(), c: proof.a.clone() };

        assert!(
            !client.verify(&CircuitId::Withdraw, &swapped, &real_public_inputs(&env)),
            "a tampered proof must not verify",
        );
    }

    #[test]
    fn real_proof_verifies_through_a_calling_contract() {
        let env = Env::default();
        env.mock_all_auths();

        let verifier_id = env.register(Groth16VerifierContract, ());
        let verifier_client = Groth16VerifierContractClient::new(&env, &verifier_id);
        verifier_client.initialize(&Address::generate(&env));
        verifier_client.set_vk(&CircuitId::Withdraw, &real_vk(&env));

        // The pool reaches the verifier cross-contract, so prove that path works
        // on a real proof — not just the direct client call.
        let caller_id = env.register(CallerContract, ());
        let caller_client = CallerContractClient::new(&env, &caller_id);

        assert!(caller_client.call_verifier(
            &verifier_id,
            &CircuitId::Withdraw,
            &real_public_inputs(&env),
            &real_proof(&env),
        ));
    }

    #[test]
    fn wrong_public_input_count_is_rejected() {
        let env = Env::default();
        let client = verifier_with_real_vk(&env);

        let mut inputs = real_public_inputs(&env);
        inputs.pop_back();

        assert_eq!(
            client.try_verify(&CircuitId::Withdraw, &real_proof(&env), &inputs),
            Err(Ok(Error::PublicInputMismatch)),
        );
    }

    // ── PoC (audit): non-canonical public inputs alias mod r ──────────────
    //
    // `Bn254Fr::from_bytes` REDUCES its 32 bytes mod the BN254 scalar modulus r
    // (soroban-sdk 26.0.1 asserts this in its own `test_fr_from_bytes_reduces`).
    // `verify` therefore treats `n` and `n + k·r` as the SAME scalar, so one
    // proof verifies under 6 distinct 32-byte encodings of every public input.
    //
    // Callers key their nullifier sets on the RAW bytes, so each alias is a
    // fresh, unspent nullifier as far as the pool is concerned. This test is
    // written as the assertion we WANT to hold; it fails today, which is the
    // finding. After the fix (reject any input >= r) it becomes the regression.
    #[test]
    fn non_canonical_public_input_must_be_rejected() {
        let env = Env::default();
        let client = verifier_with_real_vk(&env);

        // Sanity: the canonical statement verifies.
        assert!(client.verify(&CircuitId::Withdraw, &real_proof(&env), &real_public_inputs(&env)));

        // nullifier + 1·r, still under 2^256 — a different 32-byte value that
        // reduces to the same field element.
        let aliased = BytesN::from_array(
            &env,
            &hex_bytes::<32>("36266872072d74d59e7a9776ee027ff8880f217b30bd6129fc858b1cf814a363"),
        );
        let canonical = real_public_inputs(&env).get(1).unwrap();
        assert_ne!(aliased, canonical, "alias must be a different byte string");

        let mut inputs = real_public_inputs(&env);
        inputs.set(1, aliased);

        // The same unmodified proof must NOT verify against a non-canonical
        // encoding of its public input.
        assert!(
            !client.verify(&CircuitId::Withdraw, &real_proof(&env), &inputs),
            "SECURITY: proof verified under a non-canonical (aliased) public input;              the pool would treat this as an unspent nullifier and pay out again",
        );
    }
}
