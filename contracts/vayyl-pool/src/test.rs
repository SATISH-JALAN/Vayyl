//! Pool tests for the Phase-1 payment-path fixes:
//! M6 (verify-then-transfer), M1 (verifier returns false, not trap),
//! M2 (full-i128 encoding / negative rejection), C4 (events),
//! H3 (nullifier permanence semantics), H4 (historical-root window).
//!
//! The real `Groth16Verifier` needs registered VKs + valid proofs, which don't
//! exist until circuits are set up (Task 5.8). To exercise the pool's control
//! flow deterministically we register a **mock verifier** whose `verify` returns
//! a value we control, matching the pool's `Groth16VerifierInterface` signature.

extern crate std;

use super::*;
use soroban_sdk::{
    contract as sdk_contract, contractimpl as sdk_contractimpl, symbol_short,
    testutils::{Address as _, Events as _},
    Address, BytesN, Env, IntoVal, Map, Symbol, Val, Vec,
};

// ---- Mock verifier -------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum MockKey {
    Result,
}

/// A stand-in for `Groth16Verifier`. Its `verify` returns whatever boolean was
/// set via `set_result` (default: true). Signature must match the pool's
/// `Groth16VerifierInterface::verify`.
#[sdk_contract]
pub struct MockVerifier;

#[sdk_contractimpl]
impl MockVerifier {
    pub fn set_result(env: Env, val: bool) {
        env.storage().instance().set(&MockKey::Result, &val);
    }

    pub fn verify(
        env: Env,
        _circuit_id: CircuitId,
        _proof: Groth16Proof,
        _public_inputs: Vec<BytesN<32>>,
    ) -> Result<bool, soroban_sdk::Error> {
        Ok(env
            .storage()
            .instance()
            .get(&MockKey::Result)
            .unwrap_or(true))
    }
}

// ---- Harness -------------------------------------------------------------

struct Fixture {
    env: Env,
    pool: VayylPoolClient<'static>,
    verifier: MockVerifierClient<'static>,
    asset: Address,
    admin: Address,
}

fn dummy_proof(env: &Env) -> Groth16Proof {
    Groth16Proof {
        a: BytesN::from_array(env, &[0u8; 64]),
        b: BytesN::from_array(env, &[0u8; 128]),
        c: BytesN::from_array(env, &[0u8; 64]),
    }
}

fn commitment(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    // Built-in SAC as the pool asset.
    let asset_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(asset_admin.clone());
    let asset = sac.address();

    // Mock verifier + ASP placeholders (pool only stores their addresses).
    let verifier_id = env.register(MockVerifier, ());
    let verifier = MockVerifierClient::new(&env, &verifier_id);

    let pool_id = env.register(VayylPool, ());
    let pool = VayylPoolClient::new(&env, &pool_id);

    let membership = Address::generate(&env);
    let non_membership = Address::generate(&env);
    let admin = Address::generate(&env);
    pool.initialize(&admin, &asset, &verifier_id, &membership, &non_membership);
    let _ = asset_admin; // SAC admin auth is covered by mock_all_auths.

    Fixture {
        env,
        pool,
        verifier,
        asset,
        admin,
    }
}

fn fund(f: &Fixture, to: &Address, amount: i128) {
    let admin_client = token::StellarAssetClient::new(&f.env, &f.asset);
    admin_client.mint(to, &amount);
}

fn balance(f: &Fixture, who: &Address) -> i128 {
    token::Client::new(&f.env, &f.asset).balance(who)
}

// ---- upgrade(): admin-gated ---------------------------------------------

#[test]
fn test_admin_getter() {
    let f = setup();
    assert_eq!(f.pool.admin(), f.admin);
}

#[test]
fn test_upgrade_requires_admin_auth() {
    // Fresh env with NO mocked auths: `initialize` takes no auth, but `upgrade`
    // must fail the admin `require_auth` before it ever touches the WASM store.
    let env = Env::default();
    let pool_id = env.register(VayylPool, ());
    let pool = VayylPoolClient::new(&env, &pool_id);

    let admin = Address::generate(&env);
    let asset = Address::generate(&env);
    let verifier = Address::generate(&env);
    let membership = Address::generate(&env);
    let non_membership = Address::generate(&env);
    pool.initialize(&admin, &asset, &verifier, &membership, &non_membership);

    let bogus_hash = BytesN::from_array(&env, &[0u8; 32]);
    let res = pool.try_upgrade(&bogus_hash);
    assert!(res.is_err(), "upgrade without admin auth must be rejected");
}

// ---- M6: verify-then-transfer -------------------------------------------

#[test]
fn test_deposit_happy_path_moves_tokens_and_inserts_leaf() {
    let f = setup();
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, 1_000);

    let asp_root = BytesN::from_array(&f.env, &[0u8; 32]);
    f.pool.deposit(
        &depositor,
        &dummy_proof(&f.env),
        &commitment(&f.env, 7),
        &500i128,
        &asp_root,
    );

    // Tokens moved into the pool; one leaf inserted.
    assert_eq!(balance(&f, &depositor), 500);
    assert_eq!(balance(&f, &f.pool.address), 500);
    assert_eq!(f.pool.get_leaf_count(), 1);
}

#[test]
fn test_deposit_invalid_proof_moves_no_tokens_m6() {
    let f = setup();
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, 1_000);
    f.verifier.set_result(&false); // proof will be rejected

    let asp_root = BytesN::from_array(&f.env, &[0u8; 32]);
    let res = f.pool.try_deposit(
        &depositor,
        &dummy_proof(&f.env),
        &commitment(&f.env, 7),
        &500i128,
        &asp_root,
    );

    assert_eq!(res, Err(Ok(Error::InvalidProof)));
    // M6: NOT ONE TOKEN moved — verify happens before transfer.
    assert_eq!(balance(&f, &depositor), 1_000);
    assert_eq!(balance(&f, &f.pool.address), 0);
    assert_eq!(f.pool.get_leaf_count(), 0);
}

// ---- C4: events ----------------------------------------------------------

#[test]
fn test_deposit_emits_event_c4() {
    let f = setup();
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, 1_000);

    let c = commitment(&f.env, 9);
    let asp_root = BytesN::from_array(&f.env, &[0u8; 32]);
    f.pool
        .deposit(&depositor, &dummy_proof(&f.env), &c, &750i128, &asp_root);

    // A deposit event was published with topic (`deposit`, commitment) and
    // Map data { leaf_index: 0, amount: 750 } (the #[contractevent] default
    // data format collects non-topic fields into a Map).
    let data: Map<Symbol, Val> = Map::from_array(
        &f.env,
        [
            (Symbol::new(&f.env, "leaf_index"), 0u32.into_val(&f.env)),
            (Symbol::new(&f.env, "amount"), 750i128.into_val(&f.env)),
        ],
    );
    let expected = soroban_sdk::vec![
        &f.env,
        (
            f.pool.address.clone(),
            (symbol_short!("deposit"), c.clone()).into_val(&f.env),
            data.into_val(&f.env),
        ),
    ];
    // Filter to the pool's own events (the SAC emits mint/transfer events too).
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.pool.address),
        expected
    );
}

// ---- M2: full-i128 encoding / negative rejection ------------------------

#[test]
fn test_deposit_rejects_negative_amount_m2() {
    let f = setup();
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, 1_000);

    let asp_root = BytesN::from_array(&f.env, &[0u8; 32]);
    let res = f.pool.try_deposit(
        &depositor,
        &dummy_proof(&f.env),
        &commitment(&f.env, 7),
        &-1i128,
        &asp_root,
    );
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_large_amount_roundtrips_in_field_bytes_m2() {
    // A value above 2^64 must not be truncated to its low 64 bits.
    let big: i128 = (1i128 << 100) + 12345;
    let bytes = i128_to_field_bytes(big).unwrap();
    // Low 16 bytes are the big-endian i128; high 16 bytes zero.
    let mut expected = [0u8; 32];
    expected[16..32].copy_from_slice(&big.to_be_bytes());
    assert_eq!(bytes, expected);
    // The old low-64-bit encoding kept only out[24..32]; bit 100 lives in the
    // high 8 bytes of the i128 (out[16..24]) and would have been dropped.
    assert!(
        bytes[16..24].iter().any(|&b| b != 0),
        "high 64 bits must survive encoding"
    );
}

// ---- H4: historical-root window -----------------------------------------

#[test]
fn test_withdraw_rejects_unknown_root_h4() {
    let f = setup();
    let recipient = Address::generate(&f.env);
    let relayer = Address::generate(&f.env);
    let bogus_root = BytesN::from_array(&f.env, &[0xAB; 32]);

    let res = f.pool.try_withdraw(
        &dummy_proof(&f.env),
        &commitment(&f.env, 1), // nullifier
        &0i128,
        &recipient,
        &bogus_root,
        &0i128,
        &relayer,
    );
    assert_eq!(res, Err(Ok(Error::UnknownRoot)));
}

#[test]
fn test_withdraw_accepts_stale_but_in_window_root_h4() {
    let f = setup();
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, 10_000);
    // Pool needs liquidity to pay out the withdraw.
    fund(&f, &f.pool.address, 10_000);

    let asp_root = BytesN::from_array(&f.env, &[0u8; 32]);

    // Deposit A → capture the root the "withdraw proof" would bind to.
    f.pool.deposit(
        &depositor,
        &dummy_proof(&f.env),
        &commitment(&f.env, 1),
        &100i128,
        &asp_root,
    );
    let root_after_a = f.pool.get_root();

    // Deposit B lands concurrently → current root changes.
    f.pool.deposit(
        &depositor,
        &dummy_proof(&f.env),
        &commitment(&f.env, 2),
        &100i128,
        &asp_root,
    );
    assert_ne!(f.pool.get_root(), root_after_a, "root should have advanced");

    // Withdraw bound to the STALE root_after_a must still verify (in-window).
    let recipient = Address::generate(&f.env);
    let relayer = Address::generate(&f.env);
    f.pool.withdraw(
        &dummy_proof(&f.env),
        &commitment(&f.env, 50), // nullifier
        &100i128,
        &recipient,
        &root_after_a,
        &0i128,
        &relayer,
    );
    assert_eq!(balance(&f, &recipient), 100);
}

// ---- H3 / double-spend: nullifier rejects reuse -------------------------

#[test]
fn test_double_spend_rejected() {
    let f = setup();
    fund(&f, &f.pool.address, 10_000);

    let asp_root = BytesN::from_array(&f.env, &[0u8; 32]);
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, 10_000);
    f.pool.deposit(
        &depositor,
        &dummy_proof(&f.env),
        &commitment(&f.env, 1),
        &100i128,
        &asp_root,
    );
    let root = f.pool.get_root();

    let recipient = Address::generate(&f.env);
    let relayer = Address::generate(&f.env);
    let nullifier = commitment(&f.env, 77);

    // First withdraw succeeds.
    f.pool.withdraw(
        &dummy_proof(&f.env),
        &nullifier,
        &10i128,
        &recipient,
        &root,
        &0i128,
        &relayer,
    );

    // Re-using the same nullifier is rejected (double-spend prevented).
    let res = f.pool.try_withdraw(
        &dummy_proof(&f.env),
        &nullifier,
        &10i128,
        &recipient,
        &f.pool.get_root(),
        &0i128,
        &relayer,
    );
    assert_eq!(res, Err(Ok(Error::NullifierAlreadyUsed)));
}

// M3 withdraw-binding landmine guard. compute_withdraw_binding must stay
// byte-identical to the frontend's computeWithdrawBinding (pool.ts), or every
// withdraw proof silently fails on-chain. The expected value below was confirmed
// equal to the JS SDK output for the same (recipient, amount) — if a soroban-sdk
// change alters Address::to_xdr, this fails loudly instead of at withdraw time.
#[test]
fn binding_matches_frontend() {
    let env = Env::default();
    let recipient = Address::from_string(&soroban_sdk::String::from_str(
        &env,
        "GCZTDHO2FG2ABMQ46ON2MN262Z7RXD7TRA2QWGGKQIZVT7ZXK6AUJ3TH",
    ));
    let amount: i128 = 1_000_000;

    let binding = VayylPool::compute_withdraw_binding(&env, &recipient, amount);
    let hex: std::string::String = binding
        .to_array()
        .iter()
        .map(|b| std::format!("{:02x}", b))
        .collect();

    // Cross-checked against pool.ts computeWithdrawBinding() in the frontend.
    assert_eq!(
        hex,
        "0eb4bf53f3d713b4c3ace9614c3faf7a8c246550dfaa337d1cb27f3c492eba75"
    );
}
