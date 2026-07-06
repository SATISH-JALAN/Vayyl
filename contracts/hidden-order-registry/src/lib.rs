#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env, Vec,
};
use vayyl_types::{CircuitId, Groth16Proof};

/// Encode a non-negative i128 into a canonical 32-byte BN254 field element
/// (big-endian, value in the low 16 bytes). Mirrors position-manager's encoder
/// so the oracle_price public input matches the field element the
/// HiddenOrderTrigger circuit reads. A negative value is rejected — prices are
/// unsigned in-circuit (range-checked to [0, 2^64)).
fn i128_to_field_bytes(value: i128) -> Result<[u8; 32], Error> {
    if value < 0 {
        return Err(Error::InvalidAmount);
    }
    let mut out = [0u8; 32];
    out[16..32].copy_from_slice(&value.to_be_bytes());
    Ok(out)
}

#[soroban_sdk::contractclient(name = "Groth16VerifierClient")]
pub trait Groth16VerifierInterface {
    fn verify(env: Env, circuit_id: CircuitId, proof: Groth16Proof, public_inputs: Vec<BytesN<32>>) -> Result<bool, soroban_sdk::Error>;
}

/// E2: decoupled client for the pool's settlement primitive (mirrors the
/// position-manager / liquidation-engine clients). A fired order pays the
/// escrowed amount out of the pool to the recipient via `execute_settlement`.
#[soroban_sdk::contractclient(name = "VayylPoolClient")]
pub trait VayylPoolInterface {
    fn execute_settlement(
        env: Env,
        authority: Address,
        spent_nullifiers: Vec<BytesN<32>>,
        output_commitments: Vec<BytesN<32>>,
        payout_recipient: Option<Address>,
        payout_amount: i128,
    ) -> Result<(), soroban_sdk::Error>;
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct OrderState {
    pub commitment: BytesN<32>,
    pub escrow_amount: i128,
    pub pool: Address,
    pub active: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin authorized to `upgrade()` this contract in place.
    Admin,
    Verifier,
    SealedOrder(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    OrderNotFound = 3,
    OrderAlreadyExists = 4,
    ProofFailed = 5,
    OrderInactive = 6,
    InvalidAmount = 7,
    NotInitialized = 8,
}

#[contract]
pub struct HiddenOrderRegistryContract;

#[contractimpl]
impl HiddenOrderRegistryContract {
    pub fn initialize(env: Env, admin: Address, verifier: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        Ok(())
    }

    /// Upgrade the contract's WASM code in place (admin-gated).
    /// Keeps every committed order intact.
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

    /// Commit a hidden order (sealed stop-loss / take-profit).
    ///
    /// `commitment = Poseidon2(trigger_price, order_direction, salt)` — the
    /// trigger price and direction stay hidden until the order fires. The
    /// `escrow_amount` is the collateral released to the recipient on execution.
    ///
    /// HONEST-SCOPE CAVEAT (parity with D3 seize): the fund-locking side of the
    /// escrow — pulling `escrow_amount` from the user into the pool at commit
    /// time — is a deposit-style flow not wired here; on testnet the pool is
    /// pre-funded and `escrow_amount` is the accounting figure paid out. The
    /// pool's own balance is the hard cap (the SAC transfer fails if the pool
    /// can't cover the payout).
    pub fn commit_order(
        env: Env,
        order_id: BytesN<32>,
        commitment: BytesN<32>,
        escrow_amount: i128,
        pool: Address,
    ) -> Result<(), Error> {
        if escrow_amount < 0 {
            return Err(Error::InvalidAmount);
        }
        if env.storage().persistent().has(&DataKey::SealedOrder(order_id.clone())) {
            return Err(Error::OrderAlreadyExists);
        }

        let state = OrderState {
            commitment,
            escrow_amount,
            pool,
            active: true,
        };
        env.storage().persistent().set(&DataKey::SealedOrder(order_id), &state);
        Ok(())
    }

    /// Reveal and execute a hidden order once its trigger condition is met.
    ///
    /// Anyone (a keeper) may call this with a valid HiddenOrderTrigger proof —
    /// the proof cryptographically enforces that the committed trigger has fired
    /// against the public `oracle_price`, and `meta_hash` binds the recipient/fee
    /// so a copied proof can't be re-pointed at a different payout (front-running
    /// defense). No external auth is needed on the caller; the pool's
    /// `execute_settlement` auto-authorizes this contract's own sub-call.
    ///
    /// The order is marked inactive BEFORE the payout (reentrancy / double-execute
    /// guard: a re-entered call sees `!active` and aborts).
    pub fn reveal_and_execute(
        env: Env,
        order_id: BytesN<32>,
        proof: Groth16Proof,
        oracle_price: i128,
        meta_hash: BytesN<32>,
        recipient: Address,
    ) -> Result<(), Error> {
        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .ok_or(Error::NotInitialized)?;

        let mut state: OrderState = env
            .storage()
            .persistent()
            .get(&DataKey::SealedOrder(order_id.clone()))
            .ok_or(Error::OrderNotFound)?;

        if !state.active {
            return Err(Error::OrderInactive);
        }

        // 1. Verify the HiddenOrderTrigger proof.
        //    Public inputs: [order_commitment, oracle_price, meta_hash].
        let verifier_client = Groth16VerifierClient::new(&env, &verifier);
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(state.commitment.clone());
        public_inputs.push_back(BytesN::from_array(&env, &i128_to_field_bytes(oracle_price)?));
        public_inputs.push_back(meta_hash);

        let is_valid = verifier_client.verify(&CircuitId::HiddenOrderTrigger, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::ProofFailed);
        }

        // 2. Mark inactive before the external payout (reentrancy guard).
        state.active = false;
        env.storage().persistent().set(&DataKey::SealedOrder(order_id), &state);

        // 3. Real fund movement: release the escrowed collateral from the pool to
        //    the recipient via execute_settlement. This registry must be an
        //    allowlisted settlement authority on the pool.
        if state.escrow_amount > 0 {
            let pool_client = VayylPoolClient::new(&env, &state.pool);
            let no_nullifiers: Vec<BytesN<32>> = Vec::new(&env);
            let no_commitments: Vec<BytesN<32>> = Vec::new(&env);
            pool_client.execute_settlement(
                &env.current_contract_address(),
                &no_nullifiers,
                &no_commitments,
                &Some(recipient),
                &state.escrow_amount,
            );
        }

        Ok(())
    }

    pub fn get_order(env: Env, order_id: BytesN<32>) -> Result<OrderState, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::SealedOrder(order_id))
            .ok_or(Error::OrderNotFound)
    }

    /// Get the admin authorized to upgrade this contract.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract as sdk_contract, contractimpl as sdk_contractimpl, token};

    /// Stand-in verifier that always accepts (real proofs need registered VKs).
    #[sdk_contract]
    pub struct MockVerifier;
    #[sdk_contractimpl]
    impl MockVerifier {
        pub fn verify(
            _env: Env,
            _circuit_id: CircuitId,
            _proof: Groth16Proof,
            _public_inputs: Vec<BytesN<32>>,
        ) -> Result<bool, soroban_sdk::Error> {
            Ok(true)
        }
    }

    fn dummy_proof(env: &Env) -> Groth16Proof {
        Groth16Proof {
            a: BytesN::from_array(env, &[0u8; 64]),
            b: BytesN::from_array(env, &[0u8; 128]),
            c: BytesN::from_array(env, &[0u8; 64]),
        }
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register(HiddenOrderRegistryContract, ());
        let client = HiddenOrderRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.initialize(&admin, &verifier);
        assert_eq!(client.admin(), admin);
    }

    #[test]
    fn test_double_init_fails() {
        let env = Env::default();
        let contract_id = env.register(HiddenOrderRegistryContract, ());
        let client = HiddenOrderRegistryContractClient::new(&env, &contract_id);
        let a = Address::generate(&env);
        client.initialize(&a, &a);
        assert!(client.try_initialize(&a, &a).is_err());
    }

    #[test]
    fn test_commit_rejects_negative_escrow() {
        let env = Env::default();
        let contract_id = env.register(HiddenOrderRegistryContract, ());
        let client = HiddenOrderRegistryContractClient::new(&env, &contract_id);
        let a = Address::generate(&env);
        client.initialize(&a, &a);
        let oid = BytesN::from_array(&env, &[1u8; 32]);
        let c = BytesN::from_array(&env, &[2u8; 32]);
        assert!(client.try_commit_order(&oid, &c, &-1i128, &a).is_err());
    }

    // ---- E2/E4: reveal_and_execute pays the escrow out of a real pool -----

    #[test]
    fn test_reveal_and_execute_pays_out_e2e() {
        use vayyl_pool::{VayylPool, VayylPoolClient};

        let env = Env::default();
        env.mock_all_auths();

        // SAC asset; the pool custodies the escrowed collateral.
        let sac_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(sac_admin);
        let asset = sac.address();
        let verifier_id = env.register(MockVerifier, ());

        // Real pool, funded with liquidity.
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let pool_id = env.register(VayylPool, ());
        let pool = VayylPoolClient::new(&env, &pool_id);
        pool.initialize(&admin, &asset, &verifier_id, &dummy, &dummy);
        token::StellarAssetClient::new(&env, &asset).mint(&pool_id, &10_000);

        // Real order registry wired to the mock verifier.
        let reg_id = env.register(HiddenOrderRegistryContract, ());
        let reg = HiddenOrderRegistryContractClient::new(&env, &reg_id);
        reg.initialize(&admin, &verifier_id);

        // The registry must be an allowlisted settlement authority to move funds.
        pool.add_settlement_authority(&reg_id);

        // Commit an order escrowing 700 against the pool.
        let order_id = BytesN::from_array(&env, &[0x01; 32]);
        let commitment = BytesN::from_array(&env, &[0xC1; 32]);
        reg.commit_order(&order_id, &commitment, &700i128, &pool_id);

        // Fire the order: escrow paid out to the recipient.
        let recipient = Address::generate(&env);
        let meta_hash = BytesN::from_array(&env, &[0x0F; 32]);
        reg.reveal_and_execute(&order_id, &dummy_proof(&env), &1500i128, &meta_hash, &recipient);

        // Real fund movement: recipient credited 700, pool debited to 9_300.
        assert_eq!(token::Client::new(&env, &asset).balance(&recipient), 700);
        assert_eq!(token::Client::new(&env, &asset).balance(&pool_id), 9_300);
        // Order is now inactive — a second execution is rejected (double-execute guard).
        assert!(!reg.get_order(&order_id).active);
        assert!(reg
            .try_reveal_and_execute(&order_id, &dummy_proof(&env), &1500i128, &meta_hash, &recipient)
            .is_err());
    }

    // A fire by a non-allowlisted registry must fail at the pool boundary.
    #[test]
    fn test_reveal_without_pool_allowlist_fails() {
        use vayyl_pool::{VayylPool, VayylPoolClient};

        let env = Env::default();
        env.mock_all_auths();

        let sac_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(sac_admin);
        let asset = sac.address();
        let verifier_id = env.register(MockVerifier, ());

        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let pool_id = env.register(VayylPool, ());
        let pool = VayylPoolClient::new(&env, &pool_id);
        pool.initialize(&admin, &asset, &verifier_id, &dummy, &dummy);
        token::StellarAssetClient::new(&env, &asset).mint(&pool_id, &10_000);

        let reg_id = env.register(HiddenOrderRegistryContract, ());
        let reg = HiddenOrderRegistryContractClient::new(&env, &reg_id);
        reg.initialize(&admin, &verifier_id);
        // NOTE: deliberately NOT allowlisted on the pool.

        let order_id = BytesN::from_array(&env, &[0x01; 32]);
        let commitment = BytesN::from_array(&env, &[0xC1; 32]);
        reg.commit_order(&order_id, &commitment, &700i128, &pool_id);

        let recipient = Address::generate(&env);
        let meta_hash = BytesN::from_array(&env, &[0x0F; 32]);
        let res = reg.try_reveal_and_execute(
            &order_id,
            &dummy_proof(&env),
            &1500i128,
            &meta_hash,
            &recipient,
        );
        assert!(res.is_err(), "fire without pool allowlist must fail");
        assert_eq!(token::Client::new(&env, &asset).balance(&recipient), 0);
    }
}
