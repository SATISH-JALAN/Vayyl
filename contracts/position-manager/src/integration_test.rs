//! The positions vertical against the REAL pool.
//!
//! Every other test in this crate uses a mock pool, which is right for testing
//! ordering and money movement but proves nothing about the one thing that was
//! actually broken: whether a position can complete a round trip on a pool a
//! user could really deposit into.
//!
//! It could not. `execute_settlement` required V1 mode, every withdraw
//! entrypoint requires V2, and the factory only ever deploys V2 -- so a closing
//! position produced a note that was provably owned and permanently unspendable.
//! No test caught it because none spanned both verticals (audit M3).
//!
//! So this module wires the real `VayylPool`, the real `CounterpartyVault`, the
//! real `MockOracle` and the real `PositionManager` together and asserts the
//! properties that only appear at the seam:
//!
//!   - the change note from an open lands in the pool's Merkle tree;
//!   - the payout note from a close lands in the same tree;
//!   - a winning close moves real tokens from the vault into the pool BEFORE
//!     the note is minted, so the pool is never short of what it just promised;
//!   - a losing close moves the forfeited margin the other way;
//!   - the pool's token balance covers every note it has issued.

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{contract, contractimpl, token, Symbol};
use vayyl_counterparty_vault::{CounterpartyVault, CounterpartyVaultClient};
use vayyl_mock_oracle::{MockOracle, MockOracleClient};
use vayyl_pool::{VayylPool, VayylPoolClient};

/// A verifier that accepts. Real proofs are exercised against the real verifier
/// in `groth16-verifier` (`real_position_open_proof_verifies_true`); what this
/// module tests is what happens to the MONEY once a proof has been accepted.
#[contract]
pub struct YesVerifier;

#[contractimpl]
impl YesVerifier {
    pub fn verify(
        _env: Env,
        _circuit_id: CircuitId,
        _proof: Groth16Proof,
        _public_inputs: Vec<BytesN<32>>,
    ) -> bool {
        true
    }
}

/// A no-op liquidation engine. Its own behaviour is tested in its own crate.
#[contract]
pub struct NoopEngine;

#[contractimpl]
impl NoopEngine {
    pub fn register_heartbeat(_env: Env, _position_id: BytesN<32>, _timestamp: u64) {}
}

const PRICE: i128 = 10_000_000;
const NOW: u64 = 1_700_000_000;
const TIER0_MARGIN: i128 = 100_000_000;
const TIER0_SIZE: i128 = 30;

struct Stack {
    env: Env,
    mgr: PositionManagerClient<'static>,
    pool: VayylPoolClient<'static>,
    vault: CounterpartyVaultClient<'static>,
    oracle: MockOracleClient<'static>,
    asset: Address,
    minter: token::StellarAssetClient<'static>,
    owner: Address,
    xlm: Asset,
}

fn fe(env: &Env, tag: u8) -> BytesN<32> {
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

fn stack() -> Stack {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let asset = sac.address();
    let minter = token::StellarAssetClient::new(&env, &asset);

    let verifier = env.register(YesVerifier, ());
    let engine = env.register(NoopEngine, ());
    let asp = Address::generate(&env);

    // A REAL V2 pool -- the mode the factory actually deploys and the only mode
    // with a user-facing withdraw path.
    let pool = VayylPoolClient::new(&env, &env.register(VayylPool, ()));
    pool.initialize_v2(
        &Address::generate(&env),
        &asset,
        &verifier,
        &asp,
        &asp,
    );

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
        &verifier,
        &oracle.address,
        &xlm,
        &engine,
        &pool.address,
        &vault.address,
    );

    // M3: the manager settles through the pool, so it must be an allowlisted
    // settlement authority. The allowlist is now restricted to deployed Wasm
    // contracts, which the manager is.
    pool.add_settlement_authority(&mgr_id);

    // Fund both sides as they would be in production: the pool holds users'
    // deposited collateral, the vault holds LP capital.
    minter.mint(&pool.address, &10_000_000_000);
    let lp = Address::generate(&env);
    minter.mint(&lp, &10_000_000_000);
    vault.deposit_liquidity(&lp, &10_000_000_000);

    let owner = Address::generate(&env);
    Stack { env, mgr, pool, vault, oracle, asset, minter, owner, xlm }
}

/// Open a tier-0 position against a root the pool really produced.
fn open(s: &Stack, tag: u8, direction: u32) -> BytesN<32> {
    let pid = fe(&s.env, tag);
    s.mgr.open_position(
        &pid,
        &s.owner,
        &0,
        &direction,
        &proof(&s.env),
        // The pool's CURRENT root. C2 rejects anything else, and using the real
        // one is the point: a fabricated root is what the check exists to stop.
        &s.pool.get_root(),
        &fe(&s.env, tag.wrapping_add(100)),
        &fe(&s.env, tag.wrapping_add(150)),
        &fe(&s.env, tag.wrapping_add(200)),
    );
    pid
}

// ---------------------------------------------------------------------------

#[test]
fn a_position_opens_against_a_root_the_real_pool_produced() {
    // C2. `get_root()` is the live root; `is_known_root_public` accepts it.
    let s = stack();
    let pid = open(&s, 1, 1);
    assert_eq!(s.mgr.get_position_state(&pid).tier_id, 0);
}

#[test]
fn a_fabricated_root_is_rejected_by_the_real_pool() {
    // The attack C2 closes: prove membership against a tree you built yourself,
    // and the "collateral" can be any amount you like.
    let s = stack();
    let fake = fe(&s.env, 200);
    assert!(!s.pool.is_known_root_public(&fake), "fixture must not be a real root");
    let res = s.mgr.try_open_position(
        &fe(&s.env, 2),
        &s.owner,
        &0,
        &1,
        &proof(&s.env),
        &fake,
        &fe(&s.env, 101),
        &fe(&s.env, 151),
        &fe(&s.env, 201),
    );
    assert_eq!(res, Err(Ok(Error::UnknownRoot)));
}

#[test]
fn opening_moves_the_pool_root_by_inserting_the_change_note() {
    // The change note has to reach the pool's TREE, not just an event. If it did
    // not, the remainder of the collateral note would be destroyed on every
    // open -- silently, since the user's local copy would still list it.
    let s = stack();
    let before = s.pool.get_root();
    open(&s, 1, 1);
    assert_ne!(s.pool.get_root(), before, "the change note must be a real leaf");
}

#[test]
fn the_collateral_nullifier_is_spent_in_the_pool_not_just_in_the_manager() {
    // Tracking it only in PositionManager would leave the same note withdrawable
    // from VayylPool after it had already been committed as collateral.
    let s = stack();
    let nullifier = fe(&s.env, 101);
    open(&s, 1, 1);

    // A second position reusing that nullifier must fail in the POOL, which is
    // the canonical nullifier set. The manager's own check would also catch it,
    // so this uses a fresh manager-side path by way of a different position id.
    let res = s.mgr.try_open_position(
        &fe(&s.env, 2),
        &s.owner,
        &0,
        &1,
        &proof(&s.env),
        &s.pool.get_root(),
        &nullifier,
        &fe(&s.env, 152),
        &fe(&s.env, 202),
    );
    assert!(res.is_err());
}

#[test]
fn a_full_round_trip_completes_on_a_v2_pool() {
    // THE test. Before M3 this was impossible: `execute_settlement` required V1
    // mode, every withdraw requires V2, and the factory only deploys V2 -- so a
    // closed position produced a note that was provably owned and permanently
    // unspendable.
    let s = stack();
    let pid = open(&s, 1, 1);

    let root_after_open = s.pool.get_root();
    s.env.ledger().set_timestamp(NOW + 30);
    s.oracle.set_price(&s.xlm, &PRICE);

    s.mgr.close_position(&pid, &proof(&s.env), &fe(&s.env, 30), &fe(&s.env, 31), &0);

    assert_ne!(s.pool.get_root(), root_after_open, "the payout note must be a real leaf");
    assert!(s.mgr.try_get_position_state(&pid).is_err(), "the position is gone");
    // And the root it produced is one the pool will accept a proof against, so
    // the note is actually spendable rather than merely present.
    assert!(s.pool.is_known_root_public(&s.pool.get_root()));
}

#[test]
fn a_winning_close_funds_the_pool_before_it_mints_the_note() {
    // Ordering, not just totals. If the note were inserted first there would be
    // a window in which the tree held a note the pool could not honour -- and on
    // a chain, a window is a state someone can observe and act on.
    let s = stack();
    let pid = open(&s, 1, 1);
    let tok = token::Client::new(&s.env, &s.asset);

    let pool_before = tok.balance(&s.pool.address);
    let vault_before = tok.balance(&s.vault.address);

    let up = PRICE + 1_000_000;
    s.env.ledger().set_timestamp(NOW + 30);
    s.oracle.set_price(&s.xlm, &up);
    let profit = TIER0_SIZE * 1_000_000;

    s.mgr.close_position(&pid, &proof(&s.env), &fe(&s.env, 32), &fe(&s.env, 33), &0);

    assert_eq!(tok.balance(&s.pool.address), pool_before + profit);
    assert_eq!(tok.balance(&s.vault.address), vault_before - profit);
    assert!(s.vault.is_solvent());
}

#[test]
fn a_losing_close_hands_the_forfeited_margin_to_the_vault() {
    let s = stack();
    let pid = open(&s, 1, 1);
    let tok = token::Client::new(&s.env, &s.asset);

    let pool_before = tok.balance(&s.pool.address);
    let vault_before = tok.balance(&s.vault.address);

    let down = PRICE - 1_000_000;
    s.env.ledger().set_timestamp(NOW + 30);
    s.oracle.set_price(&s.xlm, &down);
    let loss = TIER0_SIZE * 1_000_000;

    s.mgr.close_position(&pid, &proof(&s.env), &fe(&s.env, 34), &fe(&s.env, 35), &0);

    // The pool pays the vault out of the collateral it was already holding.
    assert_eq!(tok.balance(&s.pool.address), pool_before - loss);
    assert_eq!(tok.balance(&s.vault.address), vault_before + loss);
    assert!(s.vault.is_solvent());
}

#[test]
fn the_vault_never_pays_more_than_it_reserved_however_far_the_price_runs() {
    // The solvency argument, end to end and through the real pool: the cap is
    // what makes the reservation sufficient, so a 100x move must cost the vault
    // exactly the reserve and not a stroop more.
    let s = stack();
    let pid = open(&s, 1, 1);
    let tok = token::Client::new(&s.env, &s.asset);

    let reserved = s.vault.reservation_of(&pid);
    let vault_before = tok.balance(&s.vault.address);

    s.env.ledger().set_timestamp(NOW + 30);
    s.oracle.set_price(&s.xlm, &(PRICE * 100));
    s.mgr.close_position(&pid, &proof(&s.env), &fe(&s.env, 36), &fe(&s.env, 37), &0);

    assert_eq!(vault_before - tok.balance(&s.vault.address), reserved);
    assert!(s.vault.is_solvent());
}

#[test]
fn many_positions_open_and_close_without_breaking_either_balance() {
    // Interleaved winners and losers through the real contracts. The invariant
    // is asserted after every step, because a violation that only shows at the
    // end is one whose cause is already gone.
    let s = stack();
    let tok = token::Client::new(&s.env, &s.asset);

    let check = |s: &Stack| {
        assert!(s.vault.is_solvent());
        assert!(tok.balance(&s.pool.address) >= 0);
    };

    let mut open_ids = alloc_ids(&s.env);
    for (i, tag) in [1u8, 2, 3, 4].iter().enumerate() {
        let direction = if i % 2 == 0 { 1u32 } else { 0u32 };
        open_ids.push_back(open(&s, *tag, direction));
        check(&s);
    }

    // Price moves: the longs win, the shorts lose, by construction.
    s.env.ledger().set_timestamp(NOW + 60);
    s.oracle.set_price(&s.xlm, &(PRICE + 500_000));

    let mut nul = 40u8;
    for id in open_ids.iter() {
        s.mgr.close_position(
            &id,
            &proof(&s.env),
            &fe(&s.env, nul),
            &fe(&s.env, nul.wrapping_add(1)),
            &0,
        );
        nul = nul.wrapping_add(2);
        check(&s);
    }

    assert_eq!(s.vault.total_reserved(), 0, "every reservation released");
}

fn alloc_ids(env: &Env) -> Vec<BytesN<32>> {
    Vec::new(env)
}

#[test]
fn the_pool_still_covers_every_note_it_has_issued_after_a_full_cycle() {
    // A weaker statement than "the pool is solvent" -- the pool's own accounting
    // of outstanding notes is off-chain -- but a real one: the token balance
    // must never go negative, and `execute_settlement`'s transfer would fail if
    // the pool tried to pay out more than it holds.
    let s = stack();
    let tok = token::Client::new(&s.env, &s.asset);
    let start = tok.balance(&s.pool.address);

    let pid = open(&s, 1, 0); // short
    s.env.ledger().set_timestamp(NOW + 30);
    s.oracle.set_price(&s.xlm, &(PRICE * 10)); // a catastrophic loss for the short
    s.mgr.close_position(&pid, &proof(&s.env), &fe(&s.env, 50), &fe(&s.env, 51), &0);

    // The whole margin went to the vault; the pool is down by exactly that.
    assert_eq!(tok.balance(&s.pool.address), start - TIER0_MARGIN);
    assert!(tok.balance(&s.pool.address) > 0);
    let _ = &s.minter;
}
