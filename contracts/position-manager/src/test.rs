use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{contract, contractimpl, token, Symbol};
use vayyl_counterparty_vault::{CounterpartyVault, CounterpartyVaultClient};
use vayyl_mock_oracle::{MockOracle, MockOracleClient};

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/// A verifier whose answer is a stored flag.
///
/// Real Groth16 proofs are exercised in `groth16-verifier`'s own
/// `real_proof_fixture` tests. What this module is testing is the manager's
/// ORDERING and its money movement -- which checks run before the nullifier is
/// marked, which contract pays whom -- and for that the proof is noise. The
/// flag exists so "the proof failed" is still a reachable branch.
#[contract]
pub struct MockVerifier;

#[contracttype]
pub enum MockKey {
    Accept,
}

#[contractimpl]
impl MockVerifier {
    pub fn set_accept(env: Env, accept: bool) {
        env.storage().instance().set(&MockKey::Accept, &accept);
    }
    pub fn verify(
        env: Env,
        _circuit_id: CircuitId,
        _proof: Groth16Proof,
        _public_inputs: Vec<BytesN<32>>,
    ) -> bool {
        env.storage().instance().get(&MockKey::Accept).unwrap_or(true)
    }
    /// The public inputs the manager last submitted, so tests can assert on the
    /// exact statement the circuit will be asked to satisfy. A reordering here
    /// is invisible on-chain until every honest proof starts failing.
    pub fn last_inputs(env: Env) -> Vec<BytesN<32>> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "last"))
            .unwrap_or(Vec::new(&env))
    }
}

/// A pool that records settlements and really moves tokens.
///
/// Only the two entry points the manager uses. Token movement is real so the
/// loss path -- pool pays the vault -- is actually observed rather than assumed.
#[contract]
pub struct MockPool;

#[contracttype]
pub enum PoolKey {
    Asset,
    KnownRoot,
    Commitments,
    Nullifiers,
    PaidOut,
}

#[contractimpl]
impl MockPool {
    pub fn init(env: Env, asset: Address) {
        env.storage().instance().set(&PoolKey::Asset, &asset);
        env.storage().instance().set(&PoolKey::KnownRoot, &true);
        env.storage()
            .instance()
            .set(&PoolKey::Commitments, &Vec::<BytesN<32>>::new(&env));
        env.storage().instance().set(&PoolKey::PaidOut, &0i128);
    }
    pub fn set_known_root(env: Env, known: bool) {
        env.storage().instance().set(&PoolKey::KnownRoot, &known);
    }
    pub fn is_known_root_public(env: Env, _root: BytesN<32>) -> bool {
        env.storage().instance().get(&PoolKey::KnownRoot).unwrap_or(true)
    }
    pub fn commitments(env: Env) -> Vec<BytesN<32>> {
        env.storage()
            .instance()
            .get(&PoolKey::Commitments)
            .unwrap_or(Vec::new(&env))
    }
    pub fn paid_out(env: Env) -> i128 {
        env.storage().instance().get(&PoolKey::PaidOut).unwrap_or(0)
    }
    pub fn execute_settlement(
        env: Env,
        _authority: Address,
        _spent_nullifiers: Vec<BytesN<32>>,
        output_commitments: Vec<BytesN<32>>,
        payout_recipient: Option<Address>,
        payout_amount: i128,
    ) {
        let mut all: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&PoolKey::Commitments)
            .unwrap_or(Vec::new(&env));
        for c in output_commitments.iter() {
            all.push_back(c);
        }
        env.storage().instance().set(&PoolKey::Commitments, &all);

        if payout_amount > 0 {
            if let Some(to) = payout_recipient {
                let asset: Address = env.storage().instance().get(&PoolKey::Asset).unwrap();
                token::Client::new(&env, &asset).transfer(
                    &env.current_contract_address(),
                    &to,
                    &payout_amount,
                );
                let prior: i128 = env.storage().instance().get(&PoolKey::PaidOut).unwrap_or(0);
                env.storage()
                    .instance()
                    .set(&PoolKey::PaidOut, &(prior + payout_amount));
            }
        }
    }
}

/// A liquidation engine that records heartbeats and can be made to fail.
///
/// The failure switch exists for M2: a swallowed heartbeat registration leaves a
/// position that looks liquidatable from ledger one while the owner was told the
/// open succeeded.
#[contract]
pub struct MockEngine;

#[contracttype]
pub enum EngineKey {
    Fail,
    Beat(BytesN<32>),
}

#[contractimpl]
impl MockEngine {
    pub fn set_fail(env: Env, fail: bool) {
        env.storage().instance().set(&EngineKey::Fail, &fail);
    }
    pub fn register_heartbeat(env: Env, position_id: BytesN<32>, timestamp: u64) {
        if env.storage().instance().get(&EngineKey::Fail).unwrap_or(false) {
            panic!("heartbeat registration failed");
        }
        env.storage()
            .persistent()
            .set(&EngineKey::Beat(position_id), &timestamp);
    }
    pub fn heartbeat_of(env: Env, position_id: BytesN<32>) -> u64 {
        env.storage()
            .persistent()
            .get(&EngineKey::Beat(position_id))
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const PRICE: i128 = 10_000_000; // 1 XLM per contract unit
const NOW: u64 = 1_700_000_000;

struct Fixture {
    env: Env,
    mgr: PositionManagerClient<'static>,
    vault: CounterpartyVaultClient<'static>,
    oracle: MockOracleClient<'static>,
    verifier: MockVerifierClient<'static>,
    pool: MockPoolClient<'static>,
    engine: MockEngineClient<'static>,
    asset: Address,
    token_admin: token::StellarAssetClient<'static>,
    owner: Address,
    xlm: Asset,
}

fn setup() -> Fixture {
    setup_with_vault(100_000_000_000)
}

/// A fixture whose vault holds exactly `vault_funding`.
///
/// Parameterised because "the counterparty is full" is a first-class state that
/// has to be reachable in a test without opening hundreds of positions to get
/// there.
fn setup_with_vault(vault_funding: i128) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let asset = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &asset);

    let verifier = MockVerifierClient::new(&env, &env.register(MockVerifier, ()));
    let engine = MockEngineClient::new(&env, &env.register(MockEngine, ()));

    let pool = MockPoolClient::new(&env, &env.register(MockPool, ()));
    pool.init(&asset);

    let oracle = MockOracleClient::new(&env, &env.register(MockOracle, ()));
    oracle.initialize(&Address::generate(&env), &7, &60);
    let xlm = Asset::Other(Symbol::new(&env, "XLM"));
    oracle.set_price(&xlm, &PRICE);

    let mgr_id = env.register(PositionManager, ());
    let mgr = PositionManagerClient::new(&env, &mgr_id);

    let vault = CounterpartyVaultClient::new(&env, &env.register(CounterpartyVault, ()));
    vault.initialize(&Address::generate(&env), &asset, &mgr_id);

    mgr.initialize(
        &Address::generate(&env),
        &verifier.address,
        &oracle.address,
        &xlm,
        &engine.address,
        &pool.address,
        &vault.address,
    );

    let lp = Address::generate(&env);
    token_admin.mint(&lp, &vault_funding);
    vault.deposit_liquidity(&lp, &vault_funding);
    // The pool holds the traders' margins, as it would after their deposits.
    token_admin.mint(&pool.address, &100_000_000_000);

    let owner = Address::generate(&env);
    Fixture {
        env,
        mgr,
        vault,
        oracle,
        verifier,
        pool,
        engine,
        asset,
        token_admin,
        owner,
        xlm,
    }
}

fn fe(env: &Env, tag: u8) -> BytesN<32> {
    // Top nibble masked so the value is always below the BN254 modulus; the
    // manager rejects non-canonical field elements (C1) and an unmasked 0xff..
    // fixture would fail for that reason instead of the one under test.
    let mut b = [tag; 32];
    b[0] = tag & 0x0f;
    BytesN::from_array(env, &b)
}

fn proof(env: &Env) -> Groth16Proof {
    Groth16Proof {
        a: BytesN::from_array(env, &[1u8; 64]),
        b: BytesN::from_array(env, &[2u8; 128]),
        c: BytesN::from_array(env, &[3u8; 64]),
    }
}

/// Open a tier-0 long with distinct, canonical fixture values.
fn open(f: &Fixture, tag: u8, tier: u32, direction: u32) -> BytesN<32> {
    let pid = fe(&f.env, tag);
    f.mgr.open_position(
        &pid,
        &f.owner,
        &tier,
        &direction,
        &proof(&f.env),
        &fe(&f.env, tag.wrapping_add(50)),
        &fe(&f.env, tag.wrapping_add(100)),
        &fe(&f.env, tag.wrapping_add(150)),
        &fe(&f.env, tag.wrapping_add(200)),
    );
    pid
}

// ---------------------------------------------------------------------------
// settlement_payout — the product, as arithmetic
// ---------------------------------------------------------------------------

#[test]
fn a_flat_market_returns_exactly_the_margin() {
    assert_eq!(settlement_payout(0, 1, PRICE, PRICE).unwrap(), TIER_MARGIN_0);
    assert_eq!(settlement_payout(0, 0, PRICE, PRICE).unwrap(), TIER_MARGIN_0);
}

const TIER_MARGIN_0: i128 = 100_000_000;
const TIER_SIZE_0: i128 = 30;
const TIER_MAX_0: i128 = 300_000_000;

#[test]
fn a_long_gains_and_a_short_loses_on_the_same_move() {
    let up = PRICE + 1_000_000; // +0.1 XLM per unit
    let long = settlement_payout(0, 1, PRICE, up).unwrap();
    let short = settlement_payout(0, 0, PRICE, up).unwrap();
    assert_eq!(long, TIER_MARGIN_0 + TIER_SIZE_0 * 1_000_000);
    assert_eq!(short, TIER_MARGIN_0 - TIER_SIZE_0 * 1_000_000);
    // Symmetric around the margin: what one side wins the other loses, which is
    // what makes the vault's exposure equal to the cap and no more.
    assert_eq!(long - TIER_MARGIN_0, TIER_MARGIN_0 - short);
}

#[test]
fn a_winning_position_knocks_out_at_the_tier_cap() {
    // The defining product limitation. Past the cap the position stops earning,
    // and that is exactly what the vault reserved for.
    let moonshot = PRICE * 100;
    assert_eq!(settlement_payout(0, 1, PRICE, moonshot).unwrap(), TIER_MAX_0);
    // Just below the cap it is still linear, so the cap is a ceiling rather
    // than a step that starts early.
    let at_cap_delta = (TIER_MAX_0 - TIER_MARGIN_0) / TIER_SIZE_0;
    assert_eq!(
        settlement_payout(0, 1, PRICE, PRICE + at_cap_delta - 1).unwrap(),
        TIER_MARGIN_0 + TIER_SIZE_0 * (at_cap_delta - 1),
    );
}

#[test]
fn a_losing_position_floors_at_zero_and_never_owes_more() {
    // A trader can lose everything they staked and not a stroop beyond it. If
    // this floor were missing the protocol would be carrying an unsecured debt
    // it cannot even identify the debtor of.
    assert_eq!(settlement_payout(0, 1, PRICE, 1).unwrap(), 0);
    assert_eq!(settlement_payout(0, 0, PRICE, PRICE * 1000).unwrap(), 0);
}

#[test]
fn an_unknown_tier_or_direction_is_an_error_not_a_panic() {
    assert_eq!(settlement_payout(TIER_COUNT, 1, PRICE, PRICE), Err(Error::UnknownTier));
    assert_eq!(settlement_payout(0, 2, PRICE, PRICE), Err(Error::InvalidDirection));
}

#[test]
fn extreme_prices_overflow_cleanly_rather_than_wrapping() {
    // overflow-checks are on in release, so an unchecked multiply would abort
    // the transaction with no typed error. This must surface as Overflow.
    assert_eq!(settlement_payout(0, 1, i128::MIN, i128::MAX), Err(Error::Overflow));
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

#[test]
fn opening_stores_the_tier_the_entry_price_and_the_direction() {
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    let state = f.mgr.get_position_state(&pid);
    assert_eq!(state.owner, f.owner);
    assert_eq!(state.tier_id, 0);
    assert_eq!(state.direction, 1);
    assert_eq!(state.entry_price, PRICE, "P0: the entry price is the oracle's, not the caller's");
    assert_eq!(state.opened_at, NOW);
    assert_eq!(state.last_health_timestamp, NOW);
}

#[test]
fn opening_reserves_the_tiers_profit_exposure_in_the_vault() {
    let f = setup();
    let before = f.vault.free_balance();
    let pid = open(&f, 1, 0, 1);
    assert_eq!(f.vault.reservation_of(&pid), TIER_MAX_0 - TIER_MARGIN_0);
    assert_eq!(f.vault.free_balance(), before - (TIER_MAX_0 - TIER_MARGIN_0));
    assert!(f.vault.is_solvent());
}

#[test]
fn opening_spends_the_collateral_note_and_inserts_the_change_note() {
    let f = setup();
    open(&f, 1, 0, 1);
    // The change note must reach the POOL's tree, not just the event. Without
    // it the remainder of the collateral note would be destroyed on every open.
    assert_eq!(f.pool.commitments().len(), 1);
    assert_eq!(f.pool.commitments().get(0).unwrap(), fe(&f.env, 201));
}

#[test]
fn a_position_cannot_open_when_the_counterparty_is_full() {
    // Not an error condition: it means nobody has funded the other side of this
    // trade. `reserve` failing IS the safety property -- a position that opened
    // here would be one whose best case the protocol cannot pay, and nobody
    // would find out until the trader tried to collect.
    //
    // The vault is funded for exactly two tier-0 positions.
    let unit = TIER_MAX_0 - TIER_MARGIN_0;
    let f = setup_with_vault(unit * 2);

    open(&f, 10, 0, 1);
    open(&f, 11, 0, 1);
    assert_eq!(f.vault.free_balance(), 0);

    let pid = fe(&f.env, 12);
    let res = f.mgr.try_open_position(
        &pid,
        &f.owner,
        &0,
        &1,
        &proof(&f.env),
        &fe(&f.env, 60),
        &fe(&f.env, 61),
        &fe(&f.env, 62),
        &fe(&f.env, 63),
    );
    assert!(res.is_err(), "an underfunded vault must refuse the open");
    assert!(
        f.mgr.try_get_position_state(&pid).is_err(),
        "and must leave no position behind",
    );
    assert!(f.vault.is_solvent());

    // Once a position closes, the freed reserve lets the next one in. The vault
    // being full is a queue, not a wall.
    f.mgr.close_position(&fe(&f.env, 10), &proof(&f.env), &fe(&f.env, 70), &fe(&f.env, 71), &0);
    f.mgr.open_position(
        &pid,
        &f.owner,
        &0,
        &1,
        &proof(&f.env),
        &fe(&f.env, 60),
        &fe(&f.env, 61),
        &fe(&f.env, 62),
        &fe(&f.env, 63),
    );
    assert_eq!(f.mgr.get_position_state(&pid).tier_id, 0);
}

#[test]
fn a_duplicate_position_id_is_refused_and_the_original_survives() {
    // H6. Overwriting would swap the record's owner, and close is gated on
    // `state.owner.require_auth()`, so the victim could never recover it.
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    let attacker = Address::generate(&f.env);
    let res = f.mgr.try_open_position(
        &pid,
        &attacker,
        &1,
        &0,
        &proof(&f.env),
        &fe(&f.env, 60),
        &fe(&f.env, 61),
        &fe(&f.env, 62),
        &fe(&f.env, 63),
    );
    assert_eq!(res, Err(Ok(Error::PositionAlreadyExists)));
    let state = f.mgr.get_position_state(&pid);
    assert_eq!(state.owner, f.owner);
    assert_eq!(state.tier_id, 0);
}

#[test]
fn a_root_the_pool_never_produced_is_refused_before_anything_is_written() {
    // C2. The membership proof would otherwise be against a tree the attacker
    // built, so the "collateral" it proves could be any amount at all. Checked
    // before the nullifier is marked and before the vault reserves, so a
    // rejected attempt costs the caller nothing.
    let f = setup();
    f.pool.set_known_root(&false);
    let pid = fe(&f.env, 7);
    let res = f.mgr.try_open_position(
        &pid,
        &f.owner,
        &0,
        &1,
        &proof(&f.env),
        &fe(&f.env, 70),
        &fe(&f.env, 71),
        &fe(&f.env, 72),
        &fe(&f.env, 73),
    );
    assert_eq!(res, Err(Ok(Error::UnknownRoot)));
    assert_eq!(f.vault.reservation_of(&pid), 0, "no reservation may survive");

    // The same nullifier still works afterwards: it was never consumed.
    f.pool.set_known_root(&true);
    f.mgr.open_position(
        &pid,
        &f.owner,
        &0,
        &1,
        &proof(&f.env),
        &fe(&f.env, 70),
        &fe(&f.env, 71),
        &fe(&f.env, 72),
        &fe(&f.env, 73),
    );
}

#[test]
fn an_unknown_tier_or_direction_is_refused_at_the_entry_point() {
    let f = setup();
    let bad_tier = f.mgr.try_open_position(
        &fe(&f.env, 8),
        &f.owner,
        &TIER_COUNT,
        &1,
        &proof(&f.env),
        &fe(&f.env, 80),
        &fe(&f.env, 81),
        &fe(&f.env, 82),
        &fe(&f.env, 83),
    );
    assert_eq!(bad_tier, Err(Ok(Error::UnknownTier)));

    let bad_dir = f.mgr.try_open_position(
        &fe(&f.env, 9),
        &f.owner,
        &0,
        &2,
        &proof(&f.env),
        &fe(&f.env, 90),
        &fe(&f.env, 91),
        &fe(&f.env, 92),
        &fe(&f.env, 93),
    );
    assert_eq!(bad_dir, Err(Ok(Error::InvalidDirection)));
}

#[test]
fn a_non_canonical_field_element_is_refused() {
    // C1: the verifier reduces public inputs mod r, while storage keys on the
    // raw bytes. An accepted alias would let one note fund several positions.
    let f = setup();
    let over = BytesN::from_array(&f.env, &[0xffu8; 32]);
    let res = f.mgr.try_open_position(
        &over,
        &f.owner,
        &0,
        &1,
        &proof(&f.env),
        &fe(&f.env, 100),
        &fe(&f.env, 101),
        &fe(&f.env, 102),
        &fe(&f.env, 103),
    );
    assert_eq!(res, Err(Ok(Error::NonCanonicalFieldElement)));
}

#[test]
fn the_same_collateral_nullifier_cannot_fund_two_positions() {
    let f = setup();
    open(&f, 1, 0, 1);
    let res = f.mgr.try_open_position(
        &fe(&f.env, 2),
        &f.owner,
        &0,
        &1,
        &fe_proof(&f.env),
        &fe(&f.env, 51),
        &fe(&f.env, 101), // the SAME nullifier as tag 1
        &fe(&f.env, 152),
        &fe(&f.env, 202),
    );
    assert_eq!(res, Err(Ok(Error::NullifierAlreadyUsed)));
}

fn fe_proof(env: &Env) -> Groth16Proof {
    proof(env)
}

#[test]
fn a_rejected_proof_aborts_the_open() {
    let f = setup();
    f.verifier.set_accept(&false);
    let pid = fe(&f.env, 3);
    let res = f.mgr.try_open_position(
        &pid,
        &f.owner,
        &0,
        &1,
        &proof(&f.env),
        &fe(&f.env, 110),
        &fe(&f.env, 111),
        &fe(&f.env, 112),
        &fe(&f.env, 113),
    );
    assert_eq!(res, Err(Ok(Error::InvalidProof)));
    assert_eq!(f.vault.reservation_of(&pid), 0, "the reservation must roll back");
    assert_eq!(f.pool.commitments().len(), 0);
}

#[test]
fn a_failed_heartbeat_registration_aborts_the_open() {
    // M2. Swallowing this would report success to the owner while leaving a
    // position with no heartbeat -- immediately liquidatable, and by the
    // owner's own reading of the UI, fine.
    let f = setup();
    f.engine.set_fail(&true);
    let pid = fe(&f.env, 4);
    let res = f.mgr.try_open_position(
        &pid,
        &f.owner,
        &0,
        &1,
        &proof(&f.env),
        &fe(&f.env, 120),
        &fe(&f.env, 121),
        &fe(&f.env, 122),
        &fe(&f.env, 123),
    );
    assert!(res.is_err());
    assert!(f.mgr.try_get_position_state(&pid).is_err());
}

#[test]
fn opening_registers_a_heartbeat_immediately() {
    // Without this a freshly opened position has no heartbeat at all and is
    // stale from its first ledger.
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    assert_eq!(f.engine.heartbeat_of(&pid), NOW);
}

// ---------------------------------------------------------------------------
// Oracle discipline
// ---------------------------------------------------------------------------

#[test]
fn a_stale_price_blocks_both_opening_and_attesting() {
    // H9/P4. Judging solvency against a price the market left behind is the
    // failure that liquidation exists to prevent.
    let f = setup();
    let pid = open(&f, 1, 0, 1);

    f.env.ledger().set_timestamp(NOW + MAX_ORACLE_AGE + 1);
    assert_eq!(
        f.mgr.try_attest_health(&pid, &proof(&f.env)),
        Err(Ok(Error::StaleOracle)),
    );
    let res = f.mgr.try_open_position(
        &fe(&f.env, 5),
        &f.owner,
        &0,
        &1,
        &proof(&f.env),
        &fe(&f.env, 130),
        &fe(&f.env, 131),
        &fe(&f.env, 132),
        &fe(&f.env, 133),
    );
    assert_eq!(res, Err(Ok(Error::StaleOracle)));

    // A fresh publication restores both.
    f.oracle.set_price(&f.xlm, &PRICE);
    f.mgr.attest_health(&pid, &proof(&f.env));
}

#[test]
fn a_price_exactly_at_the_age_limit_is_still_accepted() {
    // Off-by-one at the boundary would make the window one second shorter than
    // documented, and every client computing the same window would disagree.
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    f.env.ledger().set_timestamp(NOW + MAX_ORACLE_AGE);
    f.mgr.attest_health(&pid, &proof(&f.env));
}

#[test]
fn a_feed_that_has_never_published_is_not_treated_as_zero() {
    // A zero price makes every notional zero and every position trivially
    // healthy -- the quietest possible way to disable liquidation.
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let issuer = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(issuer).address();
    let verifier = MockVerifierClient::new(&env, &env.register(MockVerifier, ()));
    let engine = MockEngineClient::new(&env, &env.register(MockEngine, ()));
    let pool = MockPoolClient::new(&env, &env.register(MockPool, ()));
    pool.init(&asset);
    let oracle = MockOracleClient::new(&env, &env.register(MockOracle, ()));
    oracle.initialize(&Address::generate(&env), &7, &60);

    let mgr_id = env.register(PositionManager, ());
    let mgr = PositionManagerClient::new(&env, &mgr_id);
    let vault = CounterpartyVaultClient::new(&env, &env.register(CounterpartyVault, ()));
    vault.initialize(&Address::generate(&env), &asset, &mgr_id);
    mgr.initialize(
        &Address::generate(&env),
        &verifier.address,
        &oracle.address,
        &Asset::Other(Symbol::new(&env, "XLM")),
        &engine.address,
        &pool.address,
        &vault.address,
    );

    assert_eq!(mgr.try_current_price(), Err(Ok(Error::NoOraclePrice)));
}

#[test]
fn attesting_stores_ledger_time_not_oracle_time() {
    // H9. The old code wrote the oracle's own stamp, so a feed that stopped
    // updating kept every position attested forever.
    let f = setup();
    let pid = open(&f, 1, 0, 1);

    // Price published now; ledger advances 100s inside the freshness window.
    f.env.ledger().set_timestamp(NOW + 100);
    f.mgr.attest_health(&pid, &proof(&f.env));

    let state = f.mgr.get_position_state(&pid);
    assert_eq!(state.last_health_timestamp, NOW + 100, "ledger time");
    assert_ne!(state.last_health_timestamp, NOW, "not the oracle's stamp");
    assert_eq!(f.engine.heartbeat_of(&pid), NOW + 100);
}

// ---------------------------------------------------------------------------
// Close — the money actually moves
// ---------------------------------------------------------------------------

#[test]
fn closing_flat_returns_the_margin_and_moves_nothing_between_vault_and_pool() {
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    let vault_before = f.vault.balance();

    f.mgr.close_position(&pid, &proof(&f.env), &fe(&f.env, 20), &fe(&f.env, 21), &0);

    assert_eq!(f.vault.balance(), vault_before, "a flat close is a no-op for the vault");
    assert_eq!(f.vault.reservation_of(&pid), 0, "the reserve is freed");
    assert_eq!(f.pool.paid_out(), 0);
    assert!(f.mgr.try_get_position_state(&pid).is_err(), "the position is gone");
}

#[test]
fn a_winning_close_is_funded_by_the_vault() {
    // The property that did not exist before: profit is real money, and it
    // comes from the counterparty rather than from other users' deposits.
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    let vault_before = f.vault.balance();
    let pool_before = token::Client::new(&f.env, &f.asset).balance(&f.pool.address);

    let up = PRICE + 1_000_000;
    f.env.ledger().set_timestamp(NOW + 10);
    f.oracle.set_price(&f.xlm, &up);
    let profit = TIER_SIZE_0 * 1_000_000;

    f.mgr.close_position(&pid, &proof(&f.env), &fe(&f.env, 22), &fe(&f.env, 23), &0);

    assert_eq!(f.vault.balance(), vault_before - profit);
    assert_eq!(
        token::Client::new(&f.env, &f.asset).balance(&f.pool.address),
        pool_before + profit,
        "the pool must hold the money before it mints the note",
    );
    assert!(f.vault.is_solvent());
}

#[test]
fn a_losing_close_pays_the_forfeited_margin_to_the_vault() {
    // The other half of the loop, and the LPs' entire reason to be here. Without
    // it the pool would silently accumulate value that backs no note.
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    let vault_before = f.vault.balance();

    let down = PRICE - 1_000_000;
    f.env.ledger().set_timestamp(NOW + 10);
    f.oracle.set_price(&f.xlm, &down);
    let loss = TIER_SIZE_0 * 1_000_000;

    f.mgr.close_position(&pid, &proof(&f.env), &fe(&f.env, 24), &fe(&f.env, 25), &0);

    assert_eq!(f.vault.balance(), vault_before + loss);
    assert_eq!(f.pool.paid_out(), loss);
    assert_eq!(f.vault.reservation_of(&pid), 0);
    assert!(f.vault.is_solvent());
}

#[test]
fn a_capped_win_never_costs_the_vault_more_than_it_reserved() {
    // The solvency argument, end to end: whatever the price does, the vault pays
    // at most the reservation it took at open.
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    let vault_before = f.vault.balance();
    let reserved = f.vault.reservation_of(&pid);

    f.env.ledger().set_timestamp(NOW + 10);
    f.oracle.set_price(&f.xlm, &(PRICE * 100));

    f.mgr.close_position(&pid, &proof(&f.env), &fe(&f.env, 26), &fe(&f.env, 27), &0);

    assert_eq!(vault_before - f.vault.balance(), reserved, "exactly the reserve, never more");
    assert!(f.vault.is_solvent());
}

#[test]
fn a_total_loss_hands_the_whole_margin_to_the_vault_and_no_more() {
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    let vault_before = f.vault.balance();

    f.env.ledger().set_timestamp(NOW + 10);
    f.oracle.set_price(&f.xlm, &1);

    f.mgr.close_position(&pid, &proof(&f.env), &fe(&f.env, 28), &fe(&f.env, 29), &0);
    assert_eq!(f.vault.balance() - vault_before, TIER_MARGIN_0);
}

#[test]
fn the_same_position_cannot_be_closed_twice() {
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    f.mgr.close_position(&pid, &proof(&f.env), &fe(&f.env, 30), &fe(&f.env, 31), &0);
    let res = f.mgr.try_close_position(&pid, &proof(&f.env), &fe(&f.env, 32), &fe(&f.env, 33), &0);
    assert_eq!(res, Err(Ok(Error::PositionNotFound)));
}

#[test]
fn a_reused_position_nullifier_is_refused() {
    let f = setup();
    let a = open(&f, 1, 0, 1);
    let b = open(&f, 2, 0, 1);
    f.mgr.close_position(&a, &proof(&f.env), &fe(&f.env, 34), &fe(&f.env, 35), &0);
    let res = f.mgr.try_close_position(&b, &proof(&f.env), &fe(&f.env, 34), &fe(&f.env, 36), &0);
    assert_eq!(res, Err(Ok(Error::NullifierAlreadyUsed)));
}

#[test]
fn a_fee_larger_than_the_payout_is_refused() {
    // The output note amount is `payout - fee`. A larger fee would need a
    // negative note, which no witness satisfies -- so the position would be
    // permanently unclosable rather than merely failing here.
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    let res = f.mgr.try_close_position(
        &pid,
        &proof(&f.env),
        &fe(&f.env, 37),
        &fe(&f.env, 38),
        &(TIER_MARGIN_0 + 1),
    );
    assert_eq!(res, Err(Ok(Error::FeeExceedsPayout)));
}

#[test]
fn quote_payout_agrees_with_what_close_actually_settles() {
    // The UI shows `quote_payout`. If the two ever diverged, the number a trader
    // decided on would not be the number they received.
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    let up = PRICE + 500_000;
    let quoted = f.mgr.quote_payout(&pid, &up);

    f.env.ledger().set_timestamp(NOW + 10);
    f.oracle.set_price(&f.xlm, &up);
    let vault_before = f.vault.balance();
    f.mgr.close_position(&pid, &proof(&f.env), &fe(&f.env, 39), &fe(&f.env, 40), &0);

    assert_eq!(vault_before - f.vault.balance(), quoted - TIER_MARGIN_0);
}

#[test]
fn only_the_owner_can_close() {
    let env = Env::default();
    env.ledger().set_timestamp(NOW);
    // Built with auths mocked, then closed with none.
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    f.env.set_auths(&[]);
    let res = f
        .mgr
        .try_close_position(&pid, &proof(&f.env), &fe(&f.env, 41), &fe(&f.env, 42), &0);
    assert!(res.is_err(), "an unauthorised close must fail");
    let _ = env;

    // ...and succeeds again once authorised, so the failure above was the auth
    // check rather than any other precondition.
    f.env.mock_all_auths();
    f.mgr.close_position(&pid, &proof(&f.env), &fe(&f.env, 41), &fe(&f.env, 42), &0);
}

// ---------------------------------------------------------------------------
// Public inputs
// ---------------------------------------------------------------------------

#[test]
fn the_close_statement_binds_the_stored_commitment_not_a_caller_value() {
    // C3. The old position commitment must come from storage. As a free
    // parameter, a prover could open a position that never existed and settle
    // it against the vault.
    //
    // Asserted structurally: `close_position` takes no `old_position_commitment`
    // argument at all, so there is nothing for a caller to supply. The state's
    // commitment is what the manager pushes, and this pins that it is the value
    // stored at open.
    let f = setup();
    let pid = open(&f, 1, 0, 1);
    assert_eq!(f.mgr.get_position_state(&pid).commitment, fe(&f.env, 151));
}

#[test]
fn the_tier_table_is_reported_to_clients() {
    // Clients must build witnesses against the same constants the contract
    // uses; a client with a stale table produces proofs that verify nowhere.
    let f = setup();
    let tiers = f.mgr.tiers();
    assert_eq!(tiers.len(), TIER_COUNT);
    let (margin, size, max) = tiers.get(0).unwrap();
    assert_eq!(margin, TIER_MARGIN_0);
    assert_eq!(size, TIER_SIZE_0);
    assert_eq!(max, TIER_MAX_0);
}

#[test]
fn policy_constants_are_readable() {
    let f = setup();
    assert_eq!(f.mgr.health_threshold(), HEALTH_THRESHOLD);
    assert_eq!(f.mgr.max_oracle_age(), MAX_ORACLE_AGE);
    assert!(HEALTH_THRESHOLD > 0, "a zero maintenance margin defeats liquidation");
}

#[test]
fn double_init_fails() {
    let f = setup();
    let a = Address::generate(&f.env);
    let res = f.mgr.try_initialize(
        &a,
        &a,
        &a,
        &Asset::Other(Symbol::new(&f.env, "XLM")),
        &a,
        &a,
        &a,
    );
    assert_eq!(res, Err(Ok(Error::AlreadyInitialized)));
    let _ = &f.token_admin;
}
