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
use asp_membership::{AspMembershipContract, AspMembershipContractClient};
use asp_non_membership::{AspNonMembershipContract, AspNonMembershipContractClient};
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
    PublicInputs,
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
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<bool, soroban_sdk::Error> {
        env.storage()
            .instance()
            .set(&MockKey::PublicInputs, &public_inputs);
        Ok(env
            .storage()
            .instance()
            .get(&MockKey::Result)
            .unwrap_or(true))
    }

    pub fn public_inputs(env: Env) -> Vec<BytesN<32>> {
        env.storage()
            .instance()
            .get(&MockKey::PublicInputs)
            .unwrap_or_else(|| Vec::new(&env))
    }
}

// ---- Harness -------------------------------------------------------------

struct Fixture {
    env: Env,
    pool: VayylPoolClient<'static>,
    verifier: MockVerifierClient<'static>,
    asp: AspMembershipContractClient<'static>,
    asset: Address,
    admin: Address,
}

impl Fixture {
    /// Current trusted ASP root — the value a legitimate deposit must supply.
    fn asp_root(&self) -> BytesN<32> {
        self.asp.root()
    }
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
    setup_mode(false)
}

fn setup_v2() -> Fixture {
    setup_mode(true)
}

fn setup_mode(v2: bool) -> Fixture {
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

    // Real AspMembership contract so deposit root-binding is exercised for real.
    let admin = Address::generate(&env);
    let asp_id = env.register(AspMembershipContract, ());
    let asp = AspMembershipContractClient::new(&env, &asp_id);
    asp.initialize(&admin);
    // Seed one approved member so the tree (and its root) is non-trivial.
    asp.insert_leaf(&BytesN::from_array(&env, &[0xA1; 32]));

    // A real, initialized (but empty) blocklist — matching the live deployment.
    //
    // This used to be a bare `Address::generate`, i.e. an address with no
    // contract behind it. That passed only because the blocklist check inferred
    // "not wired" from a failing probe and returned Ok, so every spend in this
    // fixture skipped enforcement entirely and no test ever noticed. Now that
    // the check fails closed, the fixture has to wire what production wires.
    let nm_id = env.register(AspNonMembershipContract, ());
    AspNonMembershipContractClient::new(&env, &nm_id).initialize(&admin);
    if v2 {
        pool.initialize_v2(&admin, &asset, &verifier_id, &asp_id, &nm_id);
    } else {
        pool.initialize(&admin, &asset, &verifier_id, &asp_id, &nm_id);
    }
    let _ = asset_admin; // SAC admin auth is covered by mock_all_auths.

    Fixture {
        env,
        pool,
        verifier,
        asp,
        asset,
        admin,
    }
}

// ---- Vault V2 fixed-denomination mode ------------------------------------

#[test]
fn test_v2_deposit_is_fixed_and_rejects_duplicate_commitment() {
    let f = setup_v2();
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, V2_DENOMINATION * 2);
    let note = commitment(&f.env, 0x21);
    let asp_root = f.asp_root();

    f.pool
        .deposit_v2(&depositor, &dummy_proof(&f.env), &note, &asp_root);

    assert_eq!(f.pool.get_denomination(), V2_DENOMINATION);
    assert_eq!(balance(&f, &depositor), V2_DENOMINATION);
    assert_eq!(balance(&f, &f.pool.address), V2_DENOMINATION);
    assert_eq!(f.pool.get_leaf_count(), 1);

    let inputs = f.verifier.public_inputs();
    assert_eq!(inputs.len(), 2);
    assert_eq!(inputs.get(0).unwrap(), note);
    assert_eq!(inputs.get(1).unwrap(), asp_root);

    let duplicate = f
        .pool
        .try_deposit_v2(&depositor, &dummy_proof(&f.env), &note, &f.asp_root());
    assert_eq!(duplicate, Err(Ok(Error::CommitmentAlreadyExists)));
}

#[test]
fn test_v2_withdraw_is_fixed_and_rejects_double_spend() {
    let f = setup_v2();
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, V2_DENOMINATION);
    f.pool.deposit_v2(
        &depositor,
        &dummy_proof(&f.env),
        &commitment(&f.env, 0x31),
        &f.asp_root(),
    );

    let recipient = Address::generate(&f.env);
    let nullifier = commitment(&f.env, 0x32);
    let root = f.pool.get_root();
    f.pool
        .withdraw_v2(&dummy_proof(&f.env), &nullifier, &recipient, &root);

    assert_eq!(balance(&f, &recipient), V2_DENOMINATION);
    assert_eq!(balance(&f, &f.pool.address), 0);
    assert_eq!(f.verifier.public_inputs().len(), 3);

    let duplicate = f
        .pool
        .try_withdraw_v2(&dummy_proof(&f.env), &nullifier, &recipient, &root);
    assert_eq!(duplicate, Err(Ok(Error::NullifierAlreadyUsed)));
}

// ---- Vault V2 shielded transfer (1-in / 1-out) ---------------------------

/// Deposit one note so the tree has a leaf and the pool holds the denomination.
fn seed_v2_note(f: &Fixture, tag: u8) -> Address {
    let depositor = Address::generate(&f.env);
    fund(f, &depositor, V2_DENOMINATION);
    f.pool.deposit_v2(
        &depositor,
        &dummy_proof(&f.env),
        &commitment(&f.env, tag),
        &f.asp_root(),
    );
    depositor
}

#[test]
fn test_v2_transfer_moves_a_note_without_moving_tokens() {
    let f = setup_v2();
    seed_v2_note(&f, 0x51);

    let nullifier = commitment(&f.env, 0x52);
    let out = commitment(&f.env, 0x53);
    let eph_x = commitment(&f.env, 0x54);
    let eph_y = commitment(&f.env, 0x55);
    let root = f.pool.get_root();

    f.pool
        .transfer_v2(&dummy_proof(&f.env), &nullifier, &out, &eph_x, &eph_y, &root);

    // The whole point of a shielded transfer: value never leaves the pool.
    assert_eq!(balance(&f, &f.pool.address), V2_DENOMINATION);
    // Exactly one new leaf — a 1-in/1-out transfer must not grow the tree by 2.
    assert_eq!(f.pool.get_leaf_count(), 2);

    // Pin the public-input vector. A silent reordering here would still verify
    // against a maliciously-shaped VK but never against the real circuit, and
    // the failure would surface only as an opaque InvalidProof on testnet.
    let inputs = f.verifier.public_inputs();
    assert_eq!(inputs.len(), 5);
    assert_eq!(inputs.get(0).unwrap(), root);
    assert_eq!(inputs.get(1).unwrap(), nullifier);
    assert_eq!(inputs.get(2).unwrap(), out);
    assert_eq!(inputs.get(3).unwrap(), eph_x);
    assert_eq!(inputs.get(4).unwrap(), eph_y);
}

#[test]
fn test_v2_transfer_rejects_double_spend() {
    let f = setup_v2();
    seed_v2_note(&f, 0x61);
    let nullifier = commitment(&f.env, 0x62);
    let root = f.pool.get_root();

    f.pool.transfer_v2(
        &dummy_proof(&f.env),
        &nullifier,
        &commitment(&f.env, 0x63),
        &commitment(&f.env, 0x64),
        &commitment(&f.env, 0x65),
        &root,
    );

    let replay = f.pool.try_transfer_v2(
        &dummy_proof(&f.env),
        &nullifier,
        &commitment(&f.env, 0x66),
        &commitment(&f.env, 0x64),
        &commitment(&f.env, 0x65),
        &f.pool.get_root(),
    );
    assert_eq!(replay, Err(Ok(Error::NullifierAlreadyUsed)));
}

#[test]
fn test_v2_transfer_output_shares_the_deposit_commitment_namespace() {
    let f = setup_v2();
    let deposited = commitment(&f.env, 0x71);
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, V2_DENOMINATION);
    f.pool
        .deposit_v2(&depositor, &dummy_proof(&f.env), &deposited, &f.asp_root());

    // Re-emitting an existing commitment would insert a second leaf sharing the
    // first note's nullifier, silently burning the second note.
    let collision = f.pool.try_transfer_v2(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0x72),
        &deposited,
        &commitment(&f.env, 0x73),
        &commitment(&f.env, 0x74),
        &f.pool.get_root(),
    );
    assert_eq!(collision, Err(Ok(Error::CommitmentAlreadyExists)));
}

#[test]
fn test_v2_transfer_rejects_unknown_root() {
    let f = setup_v2();
    seed_v2_note(&f, 0x81);
    let result = f.pool.try_transfer_v2(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0x82),
        &commitment(&f.env, 0x83),
        &commitment(&f.env, 0x84),
        &commitment(&f.env, 0x85),
        &commitment(&f.env, 0xFF),
    );
    assert_eq!(result, Err(Ok(Error::UnknownRoot)));
}

#[test]
fn test_v2_withdraw_rejects_unknown_root() {
    let f = setup_v2();
    seed_v2_note(&f, 0x86);
    let result = f.pool.try_withdraw_v2(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0x87),
        &Address::generate(&f.env),
        &commitment(&f.env, 0xFE),
    );
    assert_eq!(result, Err(Ok(Error::UnknownRoot)));
}

#[test]
fn test_v2_spend_accepts_a_stale_but_in_window_root_h4() {
    // The H4 root-history ring buffer. A user's proof is built against whatever
    // root was current when they started proving; if someone else's deposit
    // lands in the ~10s that takes, the current root has already moved on. With
    // no history window every concurrent user would fail with UnknownRoot, which
    // is a liveness bug that only appears once more than one person uses the
    // pool. This previously had V1-only coverage, which retiring V1 removed.
    let f = setup_v2();
    seed_v2_note(&f, 0xB1);
    let root_after_first = f.pool.get_root();

    seed_v2_note(&f, 0xB2);
    assert_ne!(f.pool.get_root(), root_after_first, "root should have advanced");

    // A withdraw bound to the now-stale root must still be accepted.
    let recipient = Address::generate(&f.env);
    f.pool.withdraw_v2(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0xB3),
        &recipient,
        &root_after_first,
    );
    assert_eq!(balance(&f, &recipient), V2_DENOMINATION);
}

#[test]
fn test_v2_deposit_rejects_an_asp_root_the_contract_never_issued_c3() {
    // Without this the depositor could build their own ASP tree containing
    // themselves and prove membership in it, which voids the approval set
    // entirely. Also V1-only coverage until now.
    let f = setup_v2();
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, V2_DENOMINATION);
    let result = f.pool.try_deposit_v2(
        &depositor,
        &dummy_proof(&f.env),
        &commitment(&f.env, 0xB4),
        &commitment(&f.env, 0xEE), // a root the ASP contract has never produced
    );
    assert_eq!(result, Err(Ok(Error::InvalidAspRoot)));
    assert_eq!(balance(&f, &depositor), V2_DENOMINATION, "no tokens may move");
}

#[test]
fn test_v2_deposit_accepts_a_stale_but_in_window_asp_root_c3() {
    // Same concurrency argument as H4, one level up: the ASP tree can gain a
    // member while a depositor is proving.
    let f = setup_v2();
    let stale_asp_root = f.asp_root();
    f.asp.insert_leaf(&commitment(&f.env, 0xB5));
    assert_ne!(f.asp_root(), stale_asp_root, "ASP root should have advanced");

    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, V2_DENOMINATION);
    f.pool
        .deposit_v2(&depositor, &dummy_proof(&f.env), &commitment(&f.env, 0xB6), &stale_asp_root);
    assert_eq!(f.pool.get_leaf_count(), 1);
}

#[test]
fn test_v2_deposit_emits_the_leaf_index_c4() {
    // The indexer places commitments in the tree by this field. Emitting the
    // wrong index, or none, corrupts leaf ordering for every later note — the
    // exact bug the retired V1 `Transfer` event carried.
    let f = setup_v2();
    let first = commitment(&f.env, 0xB7);
    let second = commitment(&f.env, 0xB8);
    for c in [&first, &second] {
        let depositor = Address::generate(&f.env);
        fund(&f, &depositor, V2_DENOMINATION);
        f.pool
            .deposit_v2(&depositor, &dummy_proof(&f.env), c, &f.asp_root());
    }

    // #[contractevent] puts non-topic fields in a Map. The test env exposes only
    // the most recent top-level invocation's events, so this asserts on the
    // SECOND deposit — which is the interesting one: it must report leaf_index 1,
    // not 0. A repeated or missing index is what corrupts leaf ordering
    // downstream, and it is unrecoverable once clients have built paths from it.
    let data: Map<Symbol, Val> = Map::from_array(
        &f.env,
        [
            (Symbol::new(&f.env, "leaf_index"), 1u32.into_val(&f.env)),
            (Symbol::new(&f.env, "amount"), V2_DENOMINATION.into_val(&f.env)),
        ],
    );
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.pool.address),
        soroban_sdk::vec![
            &f.env,
            (
                f.pool.address.clone(),
                (symbol_short!("deposit"), second).into_val(&f.env),
                data.into_val(&f.env),
            )
        ]
    );
    let _ = first;
}

#[test]
fn test_v2_transfer_invalid_proof_consumes_nothing() {
    let f = setup_v2();
    seed_v2_note(&f, 0x91);
    let nullifier = commitment(&f.env, 0x92);
    let out = commitment(&f.env, 0x93);
    let eph_x = commitment(&f.env, 0x94);
    let eph_y = commitment(&f.env, 0x95);
    let root = f.pool.get_root();

    f.verifier.set_result(&false);
    let rejected = f.pool.try_transfer_v2(
        &dummy_proof(&f.env),
        &nullifier,
        &out,
        &eph_x,
        &eph_y,
        &root,
    );
    assert_eq!(rejected, Err(Ok(Error::InvalidProof)));

    // The nullifier is marked before verification, so this only holds because
    // the failed call reverts. If it ever stops holding, a bad proof would
    // permanently burn the sender's note.
    f.verifier.set_result(&true);
    f.pool
        .transfer_v2(&dummy_proof(&f.env), &nullifier, &out, &eph_x, &eph_y, &root);
    assert_eq!(f.pool.get_leaf_count(), 2);
}

#[test]
fn test_v2_transfer_rejects_blocked_nullifier() {
    let (f, nm) = setup_v2_with_blocklist();
    seed_v2_note(&f, 0xA1);
    let nullifier = commitment(&f.env, 0xA2);
    nm.block_leaf(&nullifier);

    let result = f.pool.try_transfer_v2(
        &dummy_proof(&f.env),
        &nullifier,
        &commitment(&f.env, 0xA3),
        &commitment(&f.env, 0xA4),
        &commitment(&f.env, 0xA5),
        &f.pool.get_root(),
    );
    assert_eq!(result, Err(Ok(Error::NullifierBlocked)));
}

// ---- F5: blocklist enforcement fails CLOSED --------------------------------
//
// The old `assert_nullifier_not_blocked` decided whether a blocklist was "really
// wired" by comparing addresses and probing `admin()`, and returned Ok(()) when
// either said no. So a placeholder address, an uninitialized contract, or a
// reverting call all silently disabled enforcement — indistinguishable, on-chain
// and in the events, from a nullifier that had genuinely been checked and
// cleared. These tests pin the replacement: enforcement is explicit state,
// unavailable means rejected, and "off" is something an admin chose.

/// A V2 pool pointed at an address with no blocklist contract behind it —
/// exactly the configuration that used to wave every spend through.
fn setup_v2_with_missing_blocklist() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(asset_admin.clone());
    let asset = sac.address();

    let verifier_id = env.register(MockVerifier, ());
    let verifier = MockVerifierClient::new(&env, &verifier_id);
    let pool_id = env.register(VayylPool, ());
    let pool = VayylPoolClient::new(&env, &pool_id);

    let admin = Address::generate(&env);
    let asp_id = env.register(AspMembershipContract, ());
    let asp = AspMembershipContractClient::new(&env, &asp_id);
    asp.initialize(&admin);
    asp.insert_leaf(&BytesN::from_array(&env, &[0xA1; 32]));

    pool.initialize_v2(&admin, &asset, &verifier_id, &asp_id, &Address::generate(&env));

    Fixture { env, pool, verifier, asp, asset, admin }
}

#[test]
fn test_blocklist_defaults_to_enabled() {
    // Absent state must read as enabled, so an in-place `upgrade()` of a pool
    // that has never been configured starts enforcing rather than not.
    assert!(setup_v2().pool.blocklist_enabled());
}

#[test]
fn test_unavailable_blocklist_rejects_the_spend() {
    let f = setup_v2_with_missing_blocklist();
    seed_v2_note(&f, 0xC1);

    // Previously this succeeded, with the compliance check silently skipped.
    let withdrawn = f.pool.try_withdraw_v2(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0xC2),
        &Address::generate(&f.env),
        &f.pool.get_root(),
    );
    assert_eq!(withdrawn, Err(Ok(Error::BlocklistUnavailable)));

    let transferred = f.pool.try_transfer_v2(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0xC3),
        &commitment(&f.env, 0xC4),
        &commitment(&f.env, 0xC5),
        &commitment(&f.env, 0xC6),
        &f.pool.get_root(),
    );
    assert_eq!(transferred, Err(Ok(Error::BlocklistUnavailable)));
}

#[test]
fn test_admin_can_disable_enforcement_explicitly() {
    // Running without a blocklist is legitimate; it just has to be a decision
    // that is recorded and readable, not one inferred from a failing probe.
    let f = setup_v2_with_missing_blocklist();
    seed_v2_note(&f, 0xD1);

    f.pool.set_blocklist_enabled(&false);
    assert!(!f.pool.blocklist_enabled());

    f.pool.withdraw_v2(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0xD2),
        &Address::generate(&f.env),
        &f.pool.get_root(),
    );

    // And re-enabling restores enforcement rather than latching off.
    f.pool.set_blocklist_enabled(&true);
    seed_v2_note(&f, 0xD3);
    assert_eq!(
        f.pool.try_withdraw_v2(
            &dummy_proof(&f.env),
            &commitment(&f.env, 0xD4),
            &Address::generate(&f.env),
            &f.pool.get_root(),
        ),
        Err(Ok(Error::BlocklistUnavailable))
    );
}

#[test]
fn test_ragequit_survives_an_unavailable_blocklist() {
    // Failing closed must never trap funds. Rage-quit deliberately does not
    // consult the blocklist, so it stays available even when the blocklist is
    // broken — otherwise this fix would create the exact confiscation hole that
    // rage-quit exists to close.
    let f = setup_v2_with_missing_blocklist();
    let c = commitment(&f.env, 0xE1);
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, V2_DENOMINATION);
    f.pool.deposit_v2(&depositor, &dummy_proof(&f.env), &c, &f.asp_root());

    let recipient = Address::generate(&f.env);
    f.pool
        .ragequit_v2(&dummy_proof(&f.env), &c, &commitment(&f.env, 0xE2), &recipient);
    assert_eq!(balance(&f, &recipient), V2_DENOMINATION);
}

// ---- V3: arbitrary amounts ------------------------------------------------
//
// The mock verifier returns whatever we tell it, so these do NOT test the
// balance equation — that lives in the circuit and is covered by
// circuits/scripts/payment_circuits_test.mjs, which proves mint, burn,
// field-wrap and note-reuse are all rejected. What these cover is the half the
// circuit cannot: that the CONTRACT moves the right number of tokens, refuses
// to reuse a nullifier or a commitment, and keeps the tree consistent.

/// Deposit an arbitrary amount, returning the depositor.
fn seed_v3_note(f: &Fixture, tag: u8, amount: i128) -> Address {
    let depositor = Address::generate(&f.env);
    fund(f, &depositor, amount);
    f.pool.deposit_v3(
        &depositor,
        &dummy_proof(&f.env),
        &commitment(&f.env, tag),
        &f.asp_root(),
        &amount,
    );
    depositor
}

#[test]
fn test_v3_deposit_moves_the_exact_amount_requested() {
    // The point of the whole deliverable: a pool that is not confined to one
    // denomination. 100 XLM in, 100 XLM held, one leaf.
    let f = setup_v2();
    let hundred = 1_000_000_000i128;
    let depositor = seed_v3_note(&f, 0xF1, hundred);

    assert_eq!(balance(&f, &depositor), 0);
    assert_eq!(balance(&f, &f.pool.address), hundred);
    assert_eq!(f.pool.get_leaf_count(), 1);

    let inputs = f.verifier.public_inputs();
    assert_eq!(inputs.len(), 3, "commitment, asp_root, amount");
}

#[test]
fn test_v3_deposit_rejects_nonpositive_amounts() {
    let f = setup_v2();
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, 1_000);
    for bad in [0i128, -1i128] {
        assert_eq!(
            f.pool.try_deposit_v3(
                &depositor,
                &dummy_proof(&f.env),
                &commitment(&f.env, 0xF2),
                &f.asp_root(),
                &bad,
            ),
            Err(Ok(Error::InvalidAmount))
        );
    }
}

#[test]
fn test_v3_withdraw_pays_the_bound_amount() {
    let f = setup_v2();
    let hundred = 1_000_000_000i128;
    seed_v3_note(&f, 0xF3, hundred);

    let recipient = Address::generate(&f.env);
    let thirty_seven = 370_000_000i128;
    f.pool.withdraw_v3(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0xF4),
        &recipient,
        &f.pool.get_root(),
        &thirty_seven,
    );
    assert_eq!(balance(&f, &recipient), thirty_seven);
    assert_eq!(balance(&f, &f.pool.address), hundred - thirty_seven);
    assert_eq!(f.verifier.public_inputs().len(), 4, "root, nullifier, amount, binding");
}

#[test]
fn test_v3_transfer_moves_two_notes_into_two_without_moving_tokens() {
    // 100 + 20 in, 37 + 83 out. No tokens move: the pool's balance is invariant
    // and the amounts never appear on the ledger.
    let f = setup_v2();
    seed_v3_note(&f, 0xA1, 1_000_000_000);
    seed_v3_note(&f, 0xA2, 200_000_000);
    let held = balance(&f, &f.pool.address);

    f.pool.transfer_v3(
        &dummy_proof(&f.env),
        &f.pool.get_root(),
        &commitment(&f.env, 0xA3),
        &commitment(&f.env, 0xA4),
        &commitment(&f.env, 0xA5),
        &commitment(&f.env, 0xA6),
        &commitment(&f.env, 0xA7),
        &commitment(&f.env, 0xA8),
        &commitment(&f.env, 0xA9),
        &commitment(&f.env, 0xAA),
        &commitment(&f.env, 0xCC), &commitment(&f.env, 0xCD),
    );

    assert_eq!(balance(&f, &f.pool.address), held, "a transfer must move no tokens");
    assert_eq!(f.pool.get_leaf_count(), 4, "two inputs spent, two outputs inserted");
    // root, 2 nullifiers, 2 commitments, 2 ephemeral points, 2 encrypted amounts.
    assert_eq!(f.verifier.public_inputs().len(), 11);
}

#[test]
fn test_v3_transfer_rejects_reusing_a_nullifier() {
    let f = setup_v2();
    seed_v3_note(&f, 0xB1, 1_000_000_000);
    let spent = commitment(&f.env, 0xB2);
    f.pool.transfer_v3(
        &dummy_proof(&f.env), &f.pool.get_root(),
        &spent, &commitment(&f.env, 0xB3),
        &commitment(&f.env, 0xB4), &commitment(&f.env, 0xB5),
        &commitment(&f.env, 0xB6), &commitment(&f.env, 0xB7),
        &commitment(&f.env, 0xB8), &commitment(&f.env, 0xB9),
        &commitment(&f.env, 0xCC), &commitment(&f.env, 0xCD),
    );

    // Same note offered again in a later transfer.
    assert_eq!(
        f.pool.try_transfer_v3(
            &dummy_proof(&f.env), &f.pool.get_root(),
            &spent, &commitment(&f.env, 0xBB),
            &commitment(&f.env, 0xBC), &commitment(&f.env, 0xBD),
            &commitment(&f.env, 0xBE), &commitment(&f.env, 0xBF),
            &commitment(&f.env, 0xC0), &commitment(&f.env, 0xC1),
            &commitment(&f.env, 0xCC), &commitment(&f.env, 0xCD),
        ),
        Err(Ok(Error::NullifierAlreadyUsed))
    );
}

#[test]
fn test_v3_transfer_rejects_one_note_presented_as_both_inputs() {
    // Belt and braces on the circuit's own distinctness constraint. Without
    // either, a wallet could double its spendable balance in a single transfer.
    let f = setup_v2();
    seed_v3_note(&f, 0xC2, 1_000_000_000);
    let same = commitment(&f.env, 0xC3);
    assert_eq!(
        f.pool.try_transfer_v3(
            &dummy_proof(&f.env), &f.pool.get_root(),
            &same, &same,
            &commitment(&f.env, 0xC4), &commitment(&f.env, 0xC5),
            &commitment(&f.env, 0xC6), &commitment(&f.env, 0xC7),
            &commitment(&f.env, 0xC8), &commitment(&f.env, 0xC9),
            &commitment(&f.env, 0xCC), &commitment(&f.env, 0xCD),
        ),
        Err(Ok(Error::NullifierAlreadyUsed))
    );
}

#[test]
fn test_v3_transfer_rejects_duplicate_output_commitments() {
    // Two identical outputs would insert two leaves sharing one nullifier,
    // silently making the second note unspendable.
    let f = setup_v2();
    seed_v3_note(&f, 0xD1, 1_000_000_000);
    let dup = commitment(&f.env, 0xD2);
    assert_eq!(
        f.pool.try_transfer_v3(
            &dummy_proof(&f.env), &f.pool.get_root(),
            &commitment(&f.env, 0xD3), &commitment(&f.env, 0xD4),
            &dup, &dup,
            &commitment(&f.env, 0xD5), &commitment(&f.env, 0xD6),
            &commitment(&f.env, 0xD7), &commitment(&f.env, 0xD8),
            &commitment(&f.env, 0xCC), &commitment(&f.env, 0xCD),
        ),
        Err(Ok(Error::CommitmentAlreadyExists))
    );
}

#[test]
fn test_v3_transfer_output_cannot_collide_with_an_existing_note() {
    let f = setup_v2();
    let existing = commitment(&f.env, 0xE1);
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, 1_000_000_000);
    f.pool
        .deposit_v3(&depositor, &dummy_proof(&f.env), &existing, &f.asp_root(), &1_000_000_000);

    assert_eq!(
        f.pool.try_transfer_v3(
            &dummy_proof(&f.env), &f.pool.get_root(),
            &commitment(&f.env, 0xE2), &commitment(&f.env, 0xE3),
            &existing, &commitment(&f.env, 0xE4),
            &commitment(&f.env, 0xE5), &commitment(&f.env, 0xE6),
            &commitment(&f.env, 0xE7), &commitment(&f.env, 0xE8),
            &commitment(&f.env, 0xCC), &commitment(&f.env, 0xCD),
        ),
        Err(Ok(Error::CommitmentAlreadyExists))
    );
}

#[test]
fn test_v3_entrypoints_are_disabled_on_a_v1_pool() {
    let f = setup(); // V1 settlement pool: no denomination key
    let depositor = Address::generate(&f.env);
    assert_eq!(
        f.pool.try_deposit_v3(
            &depositor, &dummy_proof(&f.env), &commitment(&f.env, 0xF9),
            &f.asp_root(), &1_000i128,
        ),
        Err(Ok(Error::WrongPoolMode))
    );
}

#[test]
fn test_transfer_v2_is_disabled_on_v1_pool() {
    let f = setup();
    let result = f.pool.try_transfer_v2(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0xB1),
        &commitment(&f.env, 0xB2),
        &commitment(&f.env, 0xB3),
        &commitment(&f.env, 0xB4),
        &f.pool.get_root(),
    );
    assert_eq!(result, Err(Ok(Error::WrongPoolMode)));
}

#[test]
fn test_v2_deposit_transfer_withdraw_chain() {
    // The contract-level end-to-end: A shields, A transfers to B, B unshields.
    let f = setup_v2();
    seed_v2_note(&f, 0xC1);

    let out = commitment(&f.env, 0xC3);
    f.pool.transfer_v2(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0xC2),
        &out,
        &commitment(&f.env, 0xC4),
        &commitment(&f.env, 0xC5),
        &f.pool.get_root(),
    );
    assert_eq!(balance(&f, &f.pool.address), V2_DENOMINATION);

    let recipient = Address::generate(&f.env);
    f.pool.withdraw_v2(
        &dummy_proof(&f.env),
        &commitment(&f.env, 0xC6),
        &recipient,
        &f.pool.get_root(),
    );

    assert_eq!(balance(&f, &recipient), V2_DENOMINATION);
    assert_eq!(balance(&f, &f.pool.address), 0);
    assert_eq!(f.pool.get_leaf_count(), 2);
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

// ---- C3: ASP membership root-binding ------------------------------------

// ---- V2-ready ASP non-membership on transfer/withdraw -------------------

fn setup_with_blocklist() -> (Fixture, AspNonMembershipContractClient<'static>) {
    setup_with_blocklist_mode(false)
}

fn setup_v2_with_blocklist() -> (Fixture, AspNonMembershipContractClient<'static>) {
    setup_with_blocklist_mode(true)
}

fn setup_with_blocklist_mode(v2: bool) -> (Fixture, AspNonMembershipContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(asset_admin.clone());
    let asset = sac.address();

    let verifier_id = env.register(MockVerifier, ());
    let verifier = MockVerifierClient::new(&env, &verifier_id);

    let pool_id = env.register(VayylPool, ());
    let pool = VayylPoolClient::new(&env, &pool_id);

    let admin = Address::generate(&env);
    let asp_id = env.register(AspMembershipContract, ());
    let asp = AspMembershipContractClient::new(&env, &asp_id);
    asp.initialize(&admin);
    asp.insert_leaf(&BytesN::from_array(&env, &[0xA1; 32]));

    let nm_id = env.register(AspNonMembershipContract, ());
    let nm = AspNonMembershipContractClient::new(&env, &nm_id);
    nm.initialize(&admin);

    if v2 {
        pool.initialize_v2(&admin, &asset, &verifier_id, &asp_id, &nm_id);
    } else {
        pool.initialize(&admin, &asset, &verifier_id, &asp_id, &nm_id);
    }

    let f = Fixture {
        env,
        pool,
        verifier,
        asp,
        asset,
        admin,
    };
    (f, nm)
}

// ---- C4: events ----------------------------------------------------------

// ---- M2: full-i128 encoding / negative rejection ------------------------

// ---- H4: historical-root window -----------------------------------------

// ---- H3 / double-spend: nullifier rejects reuse -------------------------

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

// ---- D1: execute_settlement (the fund-movement primitive) ---------------

#[test]
fn test_execute_settlement_inserts_note_and_pays_out() {
    let f = setup();
    // Pool holds liquidity to pay a seizure/payout from.
    fund(&f, &f.pool.address, 10_000);

    let authority = Address::generate(&f.env);
    f.pool.add_settlement_authority(&authority);
    assert!(f.pool.is_settlement_authority(&authority));

    let recipient = Address::generate(&f.env);
    let mut outs: Vec<BytesN<32>> = Vec::new(&f.env);
    outs.push_back(commitment(&f.env, 42));
    let mut nfs: Vec<BytesN<32>> = Vec::new(&f.env);
    nfs.push_back(commitment(&f.env, 7)); // a spent nullifier

    f.pool
        .execute_settlement(&authority, &nfs, &outs, &Some(recipient.clone()), &600i128);

    // Output note inserted into the tree, payout delivered, pool debited.
    assert_eq!(f.pool.get_leaf_count(), 1);
    assert_eq!(balance(&f, &recipient), 600);
    assert_eq!(balance(&f, &f.pool.address), 9_400);
}

#[test]
fn test_execute_settlement_reshield_moves_no_tokens() {
    // Position-close path: pure re-shield — insert the output note, no payout.
    let f = setup();
    fund(&f, &f.pool.address, 1_000);

    let authority = Address::generate(&f.env);
    f.pool.add_settlement_authority(&authority);

    let mut outs: Vec<BytesN<32>> = Vec::new(&f.env);
    outs.push_back(commitment(&f.env, 11));
    let nfs: Vec<BytesN<32>> = Vec::new(&f.env);

    f.pool
        .execute_settlement(&authority, &nfs, &outs, &None::<Address>, &0i128);

    assert_eq!(f.pool.get_leaf_count(), 1);
    assert_eq!(balance(&f, &f.pool.address), 1_000); // nothing left the pool
}

#[test]
fn test_execute_settlement_rejects_non_authority() {
    // The security boundary: a caller not on the allowlist cannot move funds.
    let f = setup();
    let outsider = Address::generate(&f.env);
    let empty: Vec<BytesN<32>> = Vec::new(&f.env);
    let res = f
        .pool
        .try_execute_settlement(&outsider, &empty, &empty, &None::<Address>, &0i128);
    assert_eq!(res, Err(Ok(Error::NotSettlementAuthority)));
}

#[test]
fn test_execute_settlement_rejects_double_spend_nullifier() {
    let f = setup();
    let authority = Address::generate(&f.env);
    f.pool.add_settlement_authority(&authority);

    let empty: Vec<BytesN<32>> = Vec::new(&f.env);
    let mut nfs: Vec<BytesN<32>> = Vec::new(&f.env);
    nfs.push_back(commitment(&f.env, 21));

    f.pool
        .execute_settlement(&authority, &nfs, &empty, &None::<Address>, &0i128);
    // Re-spending the same nullifier through settlement is rejected.
    let res = f
        .pool
        .try_execute_settlement(&authority, &nfs, &empty, &None::<Address>, &0i128);
    assert_eq!(res, Err(Ok(Error::NullifierAlreadyUsed)));
}

#[test]
fn test_execute_settlement_rejects_negative_payout() {
    let f = setup();
    let authority = Address::generate(&f.env);
    f.pool.add_settlement_authority(&authority);
    let recipient = Address::generate(&f.env);
    let empty: Vec<BytesN<32>> = Vec::new(&f.env);
    let res = f
        .pool
        .try_execute_settlement(&authority, &empty, &empty, &Some(recipient), &-5i128);
    assert_eq!(res, Err(Ok(Error::InvalidAmount)));
}

#[test]
fn test_remove_settlement_authority_revokes_access() {
    let f = setup();
    let authority = Address::generate(&f.env);
    f.pool.add_settlement_authority(&authority);
    assert!(f.pool.is_settlement_authority(&authority));

    f.pool.remove_settlement_authority(&authority);
    assert!(!f.pool.is_settlement_authority(&authority));

    let empty: Vec<BytesN<32>> = Vec::new(&f.env);
    let res = f
        .pool
        .try_execute_settlement(&authority, &empty, &empty, &None::<Address>, &0i128);
    assert_eq!(res, Err(Ok(Error::NotSettlementAuthority)));
}

#[test]
fn test_pull_public_deposit_moves_tokens_from_depositor() {
    let f = setup();
    let authority = Address::generate(&f.env);
    f.pool.add_settlement_authority(&authority);
    let depositor = Address::generate(&f.env);
    fund(&f, &depositor, 2_000);

    f.pool.pull_public_deposit(&authority, &depositor, &800i128);
    assert_eq!(balance(&f, &depositor), 1_200);
    assert_eq!(balance(&f, &f.pool.address), 800);
}

// ---- Rage-quit: the public exit -----------------------------------------
//
// These pin the reason the entrypoint exists. Without it, a blocked nullifier
// is a permanent confiscation: `withdraw_v2` and `transfer_v2` both refuse it,
// and no other path releases the funds. The first test establishes that trap is
// real; the second proves rage-quit is the way out of it.

/// Deposit one V2 note and return (commitment, nullifier).
fn v2_deposited_note(f: &Fixture, seed: u8) -> (BytesN<32>, BytesN<32>) {
    let depositor = Address::generate(&f.env);
    fund(f, &depositor, V2_DENOMINATION);
    let note = commitment(&f.env, seed);
    f.pool
        .deposit_v2(&depositor, &dummy_proof(&f.env), &note, &f.asp_root());
    (note, commitment(&f.env, seed.wrapping_add(1)))
}

#[test]
fn test_blocked_nullifier_is_trapped_without_ragequit() {
    let (f, nm) = setup_v2_with_blocklist();
    let (_note, nullifier) = v2_deposited_note(&f, 0x40);
    let recipient = Address::generate(&f.env);
    let root = f.pool.get_root();
    nm.block_leaf(&nullifier);

    // Both shielded spend paths refuse it, so the funds have no route out.
    assert_eq!(
        f.pool
            .try_withdraw_v2(&dummy_proof(&f.env), &nullifier, &recipient, &root),
        Err(Ok(Error::NullifierBlocked))
    );
    assert_eq!(
        f.pool.try_transfer_v2(
            &dummy_proof(&f.env),
            &nullifier,
            &commitment(&f.env, 0x4F),
            &commitment(&f.env, 0x4E),
            &commitment(&f.env, 0x4D),
            &root,
        ),
        Err(Ok(Error::NullifierBlocked))
    );
    assert_eq!(balance(&f, &f.pool.address), V2_DENOMINATION);
}

#[test]
fn test_ragequit_releases_a_blocked_note() {
    let (f, nm) = setup_v2_with_blocklist();
    let (note, nullifier) = v2_deposited_note(&f, 0x50);
    let recipient = Address::generate(&f.env);
    nm.block_leaf(&nullifier);

    // The blocklist deliberately does NOT gate this path — denying an anonymous
    // exit is its job; seizing funds is not.
    f.pool
        .ragequit_v2(&dummy_proof(&f.env), &note, &nullifier, &recipient);

    assert_eq!(balance(&f, &recipient), V2_DENOMINATION);
    assert_eq!(balance(&f, &f.pool.address), 0);

    // Public statement is [commitment, nullifier, recipient-binding]: the
    // commitment is public precisely so the exit is linkable.
    let inputs = f.verifier.public_inputs();
    assert_eq!(inputs.len(), 3);
    assert_eq!(inputs.get(0).unwrap(), note);
    assert_eq!(inputs.get(1).unwrap(), nullifier);
}

#[test]
fn test_ragequit_rejects_commitment_this_pool_never_accepted() {
    let f = setup_v2();
    let recipient = Address::generate(&f.env);
    // Fund the pool so a successful drain would actually be possible — this must
    // fail on the inclusion check, not for want of a balance.
    let (_note, _n) = v2_deposited_note(&f, 0x60);

    let foreign = commitment(&f.env, 0xF0);
    let res = f.pool.try_ragequit_v2(
        &dummy_proof(&f.env),
        &foreign,
        &commitment(&f.env, 0xF1),
        &recipient,
    );
    assert_eq!(res, Err(Ok(Error::UnknownCommitment)));
    assert_eq!(balance(&f, &recipient), 0);
    assert_eq!(balance(&f, &f.pool.address), V2_DENOMINATION);
}

#[test]
fn test_ragequit_cannot_be_replayed() {
    let f = setup_v2();
    let (note, nullifier) = v2_deposited_note(&f, 0x70);
    let recipient = Address::generate(&f.env);

    f.pool
        .ragequit_v2(&dummy_proof(&f.env), &note, &nullifier, &recipient);
    let replay = f
        .pool
        .try_ragequit_v2(&dummy_proof(&f.env), &note, &nullifier, &recipient);

    assert_eq!(replay, Err(Ok(Error::NullifierAlreadyUsed)));
    assert_eq!(balance(&f, &recipient), V2_DENOMINATION);
}

#[test]
fn test_ragequit_and_withdraw_share_one_nullifier() {
    // The escape hatch must not become a second spend. Both paths consume the
    // same nullifier, so a note is spendable exactly once whichever route it
    // takes — in either order.
    let f = setup_v2();
    let (note, nullifier) = v2_deposited_note(&f, 0x80);
    let recipient = Address::generate(&f.env);
    let root = f.pool.get_root();

    f.pool
        .ragequit_v2(&dummy_proof(&f.env), &note, &nullifier, &recipient);
    assert_eq!(
        f.pool
            .try_withdraw_v2(&dummy_proof(&f.env), &nullifier, &recipient, &root),
        Err(Ok(Error::NullifierAlreadyUsed))
    );

    let g = setup_v2();
    let (note2, nullifier2) = v2_deposited_note(&g, 0x90);
    let recipient2 = Address::generate(&g.env);
    let root2 = g.pool.get_root();
    g.pool
        .withdraw_v2(&dummy_proof(&g.env), &nullifier2, &recipient2, &root2);
    assert_eq!(
        g.pool
            .try_ragequit_v2(&dummy_proof(&g.env), &note2, &nullifier2, &recipient2),
        Err(Ok(Error::NullifierAlreadyUsed))
    );
}

#[test]
fn test_ragequit_invalid_proof_moves_no_tokens() {
    let f = setup_v2();
    let (note, nullifier) = v2_deposited_note(&f, 0xA0);
    let recipient = Address::generate(&f.env);
    f.verifier.set_result(&false);

    let res = f
        .pool
        .try_ragequit_v2(&dummy_proof(&f.env), &note, &nullifier, &recipient);

    assert_eq!(res, Err(Ok(Error::InvalidProof)));
    assert_eq!(balance(&f, &recipient), 0);
    assert_eq!(balance(&f, &f.pool.address), V2_DENOMINATION);
}

#[test]
fn test_ragequit_event_publishes_the_commitment() {
    // Traceability is the price of the exit: the event must carry the
    // commitment so an observer can join it to the original Deposit.
    let f = setup_v2();
    let (note, nullifier) = v2_deposited_note(&f, 0xB0);
    let recipient = Address::generate(&f.env);

    f.pool
        .ragequit_v2(&dummy_proof(&f.env), &note, &nullifier, &recipient);

    // `events().all()` reports the most recent invocation only, so the deposit
    // that created this note is already out of scope — the rage-quit is the
    // single pool event expected here.
    let ragequit_data: Map<Symbol, Val> = Map::from_array(
        &f.env,
        [
            (
                Symbol::new(&f.env, "commitment"),
                note.clone().into_val(&f.env),
            ),
            (
                Symbol::new(&f.env, "recipient"),
                recipient.clone().into_val(&f.env),
            ),
            (
                Symbol::new(&f.env, "amount"),
                V2_DENOMINATION.into_val(&f.env),
            ),
        ],
    );
    let expected = soroban_sdk::vec![
        &f.env,
        (
            f.pool.address.clone(),
            (Symbol::new(&f.env, "ragequit_v2"), nullifier.clone()).into_val(&f.env),
            ragequit_data.into_val(&f.env),
        ),
    ];
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.pool.address),
        expected
    );
}
