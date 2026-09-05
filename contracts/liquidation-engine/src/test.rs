use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{contract, contractimpl, token, Symbol};
use vayyl_types::{Asset, TIER_MARGIN};

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/// A position manager that serves state and records what was done to it.
///
/// The real manager is exercised in its own crate; here it stands in so the
/// engine can be tested against every position shape, including the ones the
/// real manager would refuse to create.
#[contract]
pub struct MockManager;

#[contracttype]
pub enum MgrKey {
    State(BytesN<32>),
    Seized(BytesN<32>),
    Released(BytesN<32>),
}

#[contractimpl]
impl MockManager {
    pub fn put(env: Env, position_id: BytesN<32>, owner: Address, tier_id: u32) {
        let state = PositionState {
            owner,
            commitment: BytesN::from_array(&env, &[7u8; 32]),
            last_health_timestamp: 0,
            tier_id,
            entry_price: 10_000_000,
            direction: 1,
            opened_at: 0,
        };
        env.storage().persistent().set(&MgrKey::State(position_id), &state);
    }
    pub fn get_position_state(env: Env, position_id: BytesN<32>) -> PositionState {
        env.storage()
            .persistent()
            .get(&MgrKey::State(position_id))
            .expect("position not found")
    }
    pub fn mark_position_seized(env: Env, position_id: BytesN<32>) {
        env.storage().persistent().set(&MgrKey::Seized(position_id), &true);
    }
    pub fn release_seized_reservation(env: Env, position_id: BytesN<32>) {
        env.storage().persistent().set(&MgrKey::Released(position_id), &true);
    }
    pub fn was_seized(env: Env, position_id: BytesN<32>) -> bool {
        env.storage().persistent().has(&MgrKey::Seized(position_id))
    }
    pub fn was_released(env: Env, position_id: BytesN<32>) -> bool {
        env.storage().persistent().has(&MgrKey::Released(position_id))
    }
}

/// A pool that really transfers, so the two-recipient split is observed.
#[contract]
pub struct MockPool;

#[contracttype]
pub enum PoolKey {
    Asset,
}

#[contractimpl]
impl MockPool {
    pub fn init(env: Env, asset: Address) {
        env.storage().instance().set(&PoolKey::Asset, &asset);
    }
    pub fn execute_settlement(
        env: Env,
        _authority: Address,
        _spent_nullifiers: Vec<BytesN<32>>,
        _output_commitments: Vec<BytesN<32>>,
        payout_recipient: Option<Address>,
        payout_amount: i128,
    ) {
        if payout_amount > 0 {
            if let Some(to) = payout_recipient {
                let asset: Address = env.storage().instance().get(&PoolKey::Asset).unwrap();
                token::Client::new(&env, &asset).transfer(
                    &env.current_contract_address(),
                    &to,
                    &payout_amount,
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const GRACE: u64 = 3600;
const NOW: u64 = 1_700_000_000;

struct Fixture {
    env: Env,
    engine: LiquidationEngineContractClient<'static>,
    mgr: MockManagerClient<'static>,
    pool: MockPoolClient<'static>,
    asset: Address,
    vault: Address,
    keeper: Address,
    owner: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let issuer = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(issuer).address();
    token::StellarAssetClient::new(&env, &asset);

    let mgr = MockManagerClient::new(&env, &env.register(MockManager, ()));
    let pool = MockPoolClient::new(&env, &env.register(MockPool, ()));
    pool.init(&asset);
    token::StellarAssetClient::new(&env, &asset).mint(&pool.address, &100_000_000_000);

    let vault = Address::generate(&env);
    let engine = LiquidationEngineContractClient::new(&env, &env.register(LiquidationEngineContract, ()));
    engine.initialize(
        &Address::generate(&env),
        &mgr.address,
        &Address::generate(&env), // verifier: retained in storage, no longer on this path
        &pool.address,
        &vault,
        &GRACE,
    );

    let owner = Address::generate(&env);
    let keeper = Address::generate(&env);
    Fixture { env, engine, mgr, pool, asset, vault, keeper, owner }
}

fn pid(env: &Env, tag: u8) -> BytesN<32> {
    let mut b = [tag; 32];
    b[0] = tag & 0x0f;
    BytesN::from_array(env, &b)
}

fn secret(env: &Env, tag: u8) -> BytesN<32> {
    let mut b = [0u8; 32];
    b[31] = tag;
    BytesN::from_array(env, &b)
}

/// A live tier-0 position with a fresh heartbeat.
fn live_position(f: &Fixture, tag: u8) -> BytesN<32> {
    let id = pid(&f.env, tag);
    f.mgr.put(&id, &f.owner, &0);
    f.engine.register_heartbeat(&id, &NOW);
    id
}

fn go_stale(f: &Fixture) {
    f.env.ledger().set_timestamp(NOW + GRACE + 1);
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

#[test]
fn a_fresh_heartbeat_is_not_stale_and_a_missed_window_is() {
    let f = setup();
    let id = live_position(&f, 1);
    assert!(!f.engine.is_stale(&id));
    assert_eq!(f.engine.seconds_until_stale(&id), GRACE);

    go_stale(&f);
    assert!(f.engine.is_stale(&id));
    assert_eq!(f.engine.seconds_until_stale(&id), 0);
}

#[test]
fn the_boundary_is_exclusive_so_the_last_second_of_grace_still_counts() {
    // An off-by-one here liquidates a position one second before the window the
    // owner was told they had.
    let f = setup();
    let id = live_position(&f, 1);
    f.env.ledger().set_timestamp(NOW + GRACE);
    assert!(!f.engine.is_stale(&id), "exactly at the deadline is still alive");
    f.env.ledger().set_timestamp(NOW + GRACE + 1);
    assert!(f.engine.is_stale(&id));
}

#[test]
fn a_position_with_no_heartbeat_reads_as_stale() {
    // The only way this occurs is a position that does not exist, since
    // open_position registers a heartbeat in the same transaction.
    let f = setup();
    assert!(f.engine.is_stale(&pid(&f.env, 9)));
}

#[test]
fn a_heartbeat_near_u64_max_does_not_overflow() {
    let f = setup();
    let id = pid(&f.env, 1);
    f.engine.register_heartbeat(&id, &u64::MAX);
    assert!(!f.engine.is_stale(&id), "saturating add, not a trap");
}

#[test]
fn only_the_position_manager_may_register_a_heartbeat() {
    // H5. Anyone able to call this could reset an arbitrary position's clock and
    // block its liquidation forever.
    let env = Env::default();
    env.ledger().set_timestamp(NOW);
    let engine =
        LiquidationEngineContractClient::new(&env, &env.register(LiquidationEngineContract, ()));
    let pm = Address::generate(&env);
    env.mock_all_auths();
    engine.initialize(
        &Address::generate(&env),
        &pm,
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
        &GRACE,
    );

    env.set_auths(&[]);
    assert!(engine.try_register_heartbeat(&pid(&env, 1), &NOW).is_err());

    env.mock_all_auths();
    assert!(engine.try_register_heartbeat(&pid(&env, 1), &NOW).is_ok());
}

// ---------------------------------------------------------------------------
// Initiating
// ---------------------------------------------------------------------------

#[test]
fn a_healthy_position_cannot_be_claimed() {
    let f = setup();
    let id = live_position(&f, 1);
    let commitment = f.engine.keeper_commitment_for(&secret(&f.env, 1));
    assert_eq!(
        f.engine.try_initiate_liquidation(&f.keeper, &id, &commitment),
        Err(Ok(Error::PositionNotStale)),
    );
}

#[test]
fn a_stale_position_can_be_claimed_and_the_claim_names_the_keeper() {
    // H4. The keeper's address is stored, not just the commitment; without it
    // any passer-by could overwrite the escrow and collect.
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    let commitment = f.engine.keeper_commitment_for(&secret(&f.env, 1));
    f.engine.initiate_liquidation(&f.keeper, &id, &commitment);

    let escrow = f.engine.escrow_of(&id).unwrap();
    assert_eq!(escrow.keeper, f.keeper);
    assert_eq!(escrow.commitment, commitment);
    assert_eq!(escrow.initiated_at, NOW + GRACE + 1);
}

#[test]
fn a_second_keeper_cannot_displace_a_live_claim() {
    // The front-running hole. Previously `initiate_liquidation` was
    // unauthenticated and overwrote the escrow unconditionally, so a watcher
    // could take the bounty for work another keeper had already started.
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    f.engine
        .initiate_liquidation(&f.keeper, &id, &f.engine.keeper_commitment_for(&secret(&f.env, 1)));

    let rival = Address::generate(&f.env);
    assert_eq!(
        f.engine.try_initiate_liquidation(
            &rival,
            &id,
            &f.engine.keeper_commitment_for(&secret(&f.env, 2)),
        ),
        Err(Ok(Error::EscrowHeld)),
    );
    assert_eq!(f.engine.escrow_of(&id).unwrap().keeper, f.keeper);
}

#[test]
fn an_abandoned_claim_expires_so_the_position_is_not_blocked_forever() {
    // The other side of the same coin: a keeper who initiates and never reveals
    // must not be able to shield a position indefinitely.
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    f.engine
        .initiate_liquidation(&f.keeper, &id, &f.engine.keeper_commitment_for(&secret(&f.env, 1)));

    f.env.ledger().set_timestamp(NOW + GRACE + 1 + ESCROW_TTL + 1);
    let rival = Address::generate(&f.env);
    f.engine
        .initiate_liquidation(&rival, &id, &f.engine.keeper_commitment_for(&secret(&f.env, 2)));
    assert_eq!(f.engine.escrow_of(&id).unwrap().keeper, rival);
}

#[test]
fn the_same_keeper_may_re_initiate_to_refresh_their_own_claim() {
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    let c1 = f.engine.keeper_commitment_for(&secret(&f.env, 1));
    let c2 = f.engine.keeper_commitment_for(&secret(&f.env, 2));
    f.engine.initiate_liquidation(&f.keeper, &id, &c1);
    f.engine.initiate_liquidation(&f.keeper, &id, &c2);
    assert_eq!(f.engine.escrow_of(&id).unwrap().commitment, c2);
}

#[test]
fn a_non_canonical_commitment_is_refused() {
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    let over = BytesN::from_array(&f.env, &[0xffu8; 32]);
    assert_eq!(
        f.engine.try_initiate_liquidation(&f.keeper, &id, &over),
        Err(Ok(Error::NonCanonicalFieldElement)),
    );
}

// ---------------------------------------------------------------------------
// Seizing
// ---------------------------------------------------------------------------

fn claim(f: &Fixture, id: &BytesN<32>, tag: u8) {
    f.engine
        .initiate_liquidation(&f.keeper, id, &f.engine.keeper_commitment_for(&secret(&f.env, tag)));
}

#[test]
fn seizing_splits_the_tier_margin_between_the_keeper_and_the_vault() {
    // C4/P8: the amount comes from the position's tier, never from the caller.
    // Previously a keeper named `seize_amount` themselves, so anyone who could
    // stale-liquidate one position could name the whole pool.
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    claim(&f, &id, 1);

    let collateral = TIER_MARGIN[0];
    let expected_bounty = collateral * KEEPER_BOUNTY_BPS / 10_000;

    let seized = f.engine.reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1));
    assert_eq!(seized, collateral);

    let tok = token::Client::new(&f.env, &f.asset);
    assert_eq!(tok.balance(&f.keeper), expected_bounty);
    assert_eq!(tok.balance(&f.vault), collateral - expected_bounty);
    assert_eq!(
        tok.balance(&f.keeper) + tok.balance(&f.vault),
        collateral,
        "every stroop is accounted for",
    );
}

#[test]
fn seizing_removes_the_position_and_frees_its_vault_reservation() {
    // M2. A dropped release strands vault capital permanently, which breaks the
    // solvency invariant in the direction nothing checks.
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    claim(&f, &id, 1);
    f.engine.reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1));

    assert!(f.mgr.was_seized(&id));
    assert!(f.mgr.was_released(&id));
    assert!(f.engine.is_liquidated(&id));
}

#[test]
fn an_owner_who_cures_the_position_before_the_reveal_is_not_liquidated() {
    // H5, and the single most important test in this file. Attesting health is
    // exactly what an owner is supposed to do; being liquidated for doing it,
    // because staleness was only checked when the claim was staked, punished the
    // correct behaviour.
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    claim(&f, &id, 1);

    // The owner attests: the manager pushes a fresh heartbeat.
    let now = f.env.ledger().timestamp();
    f.engine.register_heartbeat(&id, &now);

    assert_eq!(
        f.engine.try_reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1)),
        Err(Ok(Error::PositionNotStale)),
    );
    assert!(!f.engine.is_liquidated(&id));
    assert_eq!(token::Client::new(&f.env, &f.asset).balance(&f.keeper), 0);

    // ...and once it genuinely goes stale again, the same keeper can finish.
    f.env.ledger().set_timestamp(now + GRACE + 1);
    f.engine.reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1));
    assert!(f.engine.is_liquidated(&id));
}

#[test]
fn a_wrong_secret_does_not_seize() {
    // This is the check that used to live in the circuit. It is a Poseidon2
    // preimage test, and it now runs against the same host function the
    // circuits compile to.
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    claim(&f, &id, 1);
    assert_eq!(
        f.engine.try_reveal_and_seize(&f.keeper, &id, &secret(&f.env, 99)),
        Err(Ok(Error::BadSecret)),
    );
    assert!(!f.engine.is_liquidated(&id));
}

#[test]
fn a_rival_keeper_cannot_seize_on_someone_elses_claim() {
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    claim(&f, &id, 1);
    let rival = Address::generate(&f.env);
    assert_eq!(
        f.engine.try_reveal_and_seize(&rival, &id, &secret(&f.env, 1)),
        Err(Ok(Error::KeeperMismatch)),
    );
}

#[test]
fn seizing_without_a_claim_is_refused() {
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    assert_eq!(
        f.engine.try_reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1)),
        Err(Ok(Error::EscrowNotFound)),
    );
}

#[test]
fn the_same_position_cannot_be_seized_twice() {
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    claim(&f, &id, 1);
    f.engine.reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1));

    let paid = token::Client::new(&f.env, &f.asset).balance(&f.keeper);
    assert_eq!(
        f.engine.try_reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1)),
        Err(Ok(Error::AlreadyLiquidated)),
    );
    assert_eq!(token::Client::new(&f.env, &f.asset).balance(&f.keeper), paid, "paid once");
}

#[test]
fn a_liquidated_position_cannot_be_claimed_again() {
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    claim(&f, &id, 1);
    f.engine.reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1));
    assert_eq!(
        f.engine.try_initiate_liquidation(
            &f.keeper,
            &id,
            &f.engine.keeper_commitment_for(&secret(&f.env, 2)),
        ),
        Err(Ok(Error::AlreadyLiquidated)),
    );
}

#[test]
fn a_position_in_an_unknown_tier_is_refused_rather_than_indexing_out_of_bounds() {
    let f = setup();
    let id = pid(&f.env, 2);
    f.mgr.put(&id, &f.owner, &vayyl_types::TIER_COUNT);
    f.engine.register_heartbeat(&id, &NOW);
    go_stale(&f);
    claim(&f, &id, 1);
    assert_eq!(
        f.engine.try_reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1)),
        Err(Ok(Error::UnknownTier)),
    );
}

#[test]
fn the_larger_tier_seizes_proportionally_more() {
    let f = setup();
    let id = pid(&f.env, 3);
    f.mgr.put(&id, &f.owner, &1);
    f.engine.register_heartbeat(&id, &NOW);
    go_stale(&f);
    claim(&f, &id, 1);
    assert_eq!(f.engine.reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1)), TIER_MARGIN[1]);
}

#[test]
fn seizing_requires_the_keepers_own_authorisation() {
    let f = setup();
    let id = live_position(&f, 1);
    go_stale(&f);
    claim(&f, &id, 1);

    f.env.set_auths(&[]);
    assert!(f.engine.try_reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1)).is_err());

    f.env.mock_all_auths();
    assert!(f.engine.try_reveal_and_seize(&f.keeper, &id, &secret(&f.env, 1)).is_ok());
}

// ---------------------------------------------------------------------------
// Keeper commitment
// ---------------------------------------------------------------------------

#[test]
fn the_keeper_commitment_is_deterministic_and_distinguishes_secrets() {
    let f = setup();
    let a = f.engine.keeper_commitment_for(&secret(&f.env, 1));
    let b = f.engine.keeper_commitment_for(&secret(&f.env, 2));
    assert_eq!(a, f.engine.keeper_commitment_for(&secret(&f.env, 1)));
    assert_ne!(a, b);
    assert!(is_canonical_fr(&a), "must be usable as a stored commitment");
}

#[test]
fn config_is_readable() {
    let f = setup();
    assert_eq!(f.engine.grace_period(), GRACE);
    assert_eq!(f.engine.keeper_bounty_bps(), KEEPER_BOUNTY_BPS);
    assert!(
        KEEPER_BOUNTY_BPS > 0 && KEEPER_BOUNTY_BPS < 10_000,
        "a zero bounty means nobody liquidates; a full one means nobody provides liquidity",
    );
    let _ = Asset::Other(Symbol::new(&f.env, "XLM"));
}

#[test]
fn double_init_fails() {
    let f = setup();
    let a = Address::generate(&f.env);
    assert_eq!(
        f.engine.try_initialize(&a, &a, &a, &a, &a, &GRACE),
        Err(Ok(Error::AlreadyInitialized)),
    );
}
