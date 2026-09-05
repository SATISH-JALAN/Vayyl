use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Vec as SdkVec};
use vayyl_types::{tier_margin, tier_max_payout, TIER_COUNT};

struct Fixture {
    env: Env,
    vault: CounterpartyVaultClient<'static>,
    asset: Address,
    asset_admin: token::StellarAssetClient<'static>,
    /// The PositionManager stand-in. `mock_all_auths` means any address can
    /// pass `require_auth`, so authorisation is asserted separately with
    /// `set_auths` in the test that cares about it.
    manager: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer.clone());
    let asset = sac.address();
    let asset_admin = token::StellarAssetClient::new(&env, &asset);

    let manager = Address::generate(&env);
    let vault_id = env.register(CounterpartyVault, ());
    let vault = CounterpartyVaultClient::new(&env, &vault_id);
    vault.initialize(&Address::generate(&env), &asset, &manager);

    Fixture { env, vault, asset, asset_admin, manager }
}

fn lp_with(f: &Fixture, amount: i128) -> Address {
    let lp = Address::generate(&f.env);
    f.asset_admin.mint(&lp, &amount);
    lp
}

fn pid(env: &Env, tag: u8) -> BytesN<32> {
    BytesN::from_array(env, &[tag; 32])
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

#[test]
fn an_empty_vault_is_solvent_and_reserves_nothing() {
    let f = setup();
    assert_eq!(f.vault.balance(), 0);
    assert_eq!(f.vault.total_reserved(), 0);
    assert_eq!(f.vault.free_balance(), 0);
    assert!(f.vault.is_solvent());
}

#[test]
fn a_position_cannot_open_against_an_empty_vault() {
    // This failing IS the safety property. A position that opened here would be
    // one whose best case the protocol cannot pay, and nobody would find out
    // until the trader tried to collect.
    let f = setup();
    assert_eq!(
        f.vault.try_reserve(&pid(&f.env, 1), &0),
        Err(Ok(Error::InsufficientLiquidity)),
    );
    assert_eq!(f.vault.total_reserved(), 0, "a refused reserve must leave no residue");
}

#[test]
fn reserving_sets_aside_exactly_max_payout_minus_margin() {
    let f = setup();
    let lp = lp_with(&f, 10_000_000_000);
    f.vault.deposit_liquidity(&lp, &10_000_000_000);

    for tier in 0..TIER_COUNT {
        let expected = tier_max_payout(tier).unwrap() - tier_margin(tier).unwrap();
        let reserved = f.vault.reserve(&pid(&f.env, tier as u8 + 1), &tier);
        assert_eq!(reserved, expected, "tier {} reserves the wrong amount", tier);
    }
    // The trader's own margin is NOT part of this: it stays in the pool as a
    // shielded note and the vault never touches it.
    let total: i128 = (0..TIER_COUNT)
        .map(|t| tier_max_payout(t).unwrap() - tier_margin(t).unwrap())
        .sum();
    assert_eq!(f.vault.total_reserved(), total);
    assert!(f.vault.is_solvent());
}

#[test]
fn free_balance_is_what_is_left_after_reservations() {
    let f = setup();
    let lp = lp_with(&f, 1_000_000_000);
    f.vault.deposit_liquidity(&lp, &1_000_000_000);

    let reserved = f.vault.reserve(&pid(&f.env, 1), &0);
    assert_eq!(f.vault.free_balance(), 1_000_000_000 - reserved);
    assert_eq!(f.vault.balance(), 1_000_000_000, "reserving moves no money");
}

#[test]
fn reserving_stops_exactly_when_the_money_runs_out() {
    // The vault is funded for two tier-0 positions and not a third. The third
    // must be refused rather than over-committing the same capital twice.
    let f = setup();
    let unit = tier_max_payout(0).unwrap() - tier_margin(0).unwrap();
    let lp = lp_with(&f, unit * 2);
    f.vault.deposit_liquidity(&lp, &(unit * 2));

    f.vault.reserve(&pid(&f.env, 1), &0);
    f.vault.reserve(&pid(&f.env, 2), &0);
    assert_eq!(f.vault.free_balance(), 0);
    assert_eq!(
        f.vault.try_reserve(&pid(&f.env, 3), &0),
        Err(Ok(Error::InsufficientLiquidity)),
    );
    assert!(f.vault.is_solvent());
}

#[test]
fn an_unknown_tier_is_refused_rather_than_indexing_out_of_bounds() {
    // tier_id arrives from a caller. Slice-indexing it would panic and abort the
    // transaction with no typed error to act on.
    let f = setup();
    let lp = lp_with(&f, 10_000_000_000);
    f.vault.deposit_liquidity(&lp, &10_000_000_000);
    assert_eq!(f.vault.try_reserve(&pid(&f.env, 1), &TIER_COUNT), Err(Ok(Error::UnknownTier)));
    assert_eq!(f.vault.try_reserve(&pid(&f.env, 1), &u32::MAX), Err(Ok(Error::UnknownTier)));
}

#[test]
fn the_same_position_cannot_reserve_twice() {
    // Double-reserving would inflate total_reserved and permanently strand
    // capital, since only one release ever arrives.
    let f = setup();
    let lp = lp_with(&f, 10_000_000_000);
    f.vault.deposit_liquidity(&lp, &10_000_000_000);
    f.vault.reserve(&pid(&f.env, 1), &0);
    assert_eq!(f.vault.try_reserve(&pid(&f.env, 1), &0), Err(Ok(Error::AlreadyReserved)));
}

// ---------------------------------------------------------------------------
// Release and payout
// ---------------------------------------------------------------------------

#[test]
fn releasing_a_losing_position_frees_the_reserve_and_moves_no_money() {
    let f = setup();
    let lp = lp_with(&f, 1_000_000_000);
    f.vault.deposit_liquidity(&lp, &1_000_000_000);
    let recipient = Address::generate(&f.env);

    let reserved = f.vault.reserve(&pid(&f.env, 1), &0);
    let freed = f.vault.release(&pid(&f.env, 1), &recipient, &0);

    assert_eq!(freed, reserved);
    assert_eq!(f.vault.total_reserved(), 0);
    assert_eq!(f.vault.balance(), 1_000_000_000);
    assert_eq!(f.vault.free_balance(), 1_000_000_000);
}

#[test]
fn releasing_a_winning_position_pays_the_profit_out_of_the_vault() {
    let f = setup();
    let lp = lp_with(&f, 1_000_000_000);
    f.vault.deposit_liquidity(&lp, &1_000_000_000);
    let pool = Address::generate(&f.env);

    let reserved = f.vault.reserve(&pid(&f.env, 1), &0);
    let profit = reserved / 2;
    f.vault.release(&pid(&f.env, 1), &pool, &profit);

    assert_eq!(token::Client::new(&f.env, &f.asset).balance(&pool), profit);
    assert_eq!(f.vault.balance(), 1_000_000_000 - profit);
    assert_eq!(f.vault.total_reserved(), 0);
    assert!(f.vault.is_solvent());
}

#[test]
fn a_payout_larger_than_this_positions_reserve_is_refused() {
    // The cap is per position, not global. Without it a settlement could spend
    // the money set aside for somebody else's position, and the vault would
    // still look solvent right up until that other position closed.
    let f = setup();
    let lp = lp_with(&f, 10_000_000_000);
    f.vault.deposit_liquidity(&lp, &10_000_000_000);
    let pool = Address::generate(&f.env);

    let reserved = f.vault.reserve(&pid(&f.env, 1), &0);
    f.vault.reserve(&pid(&f.env, 2), &1); // a much larger reserve sitting alongside

    assert_eq!(
        f.vault.try_release(&pid(&f.env, 1), &pool, &(reserved + 1)),
        Err(Ok(Error::PayoutExceedsReservation)),
    );
    assert_eq!(f.vault.reservation_of(&pid(&f.env, 1)), reserved, "still reserved");
}

#[test]
fn releasing_twice_is_refused() {
    // Accounting happens before the transfer precisely so a second call finds
    // nothing to release; this pins that ordering.
    let f = setup();
    let lp = lp_with(&f, 1_000_000_000);
    f.vault.deposit_liquidity(&lp, &1_000_000_000);
    let pool = Address::generate(&f.env);

    f.vault.reserve(&pid(&f.env, 1), &0);
    f.vault.release(&pid(&f.env, 1), &pool, &1_000);
    assert_eq!(
        f.vault.try_release(&pid(&f.env, 1), &pool, &1_000),
        Err(Ok(Error::NotReserved)),
    );
    assert_eq!(token::Client::new(&f.env, &f.asset).balance(&pool), 1_000, "paid once");
}

#[test]
fn releasing_an_unknown_position_is_refused() {
    let f = setup();
    let pool = Address::generate(&f.env);
    assert_eq!(
        f.vault.try_release(&pid(&f.env, 9), &pool, &0),
        Err(Ok(Error::NotReserved)),
    );
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

#[test]
fn only_the_position_manager_may_reserve_or_release() {
    // Without `mock_all_auths`, `require_auth` is enforced for real. An
    // unauthorised reserve would let anyone lock up LP capital for free; an
    // unauthorised release would let anyone drain a reservation.
    let env = Env::default();
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer.clone());
    let asset = sac.address();

    let manager = Address::generate(&env);
    let vault_id = env.register(CounterpartyVault, ());
    let vault = CounterpartyVaultClient::new(&env, &vault_id);

    env.mock_all_auths();
    vault.initialize(&Address::generate(&env), &asset, &manager);
    let lp = Address::generate(&env);
    token::StellarAssetClient::new(&env, &asset).mint(&lp, &10_000_000_000);
    vault.deposit_liquidity(&lp, &10_000_000_000);

    // From here on, nothing is authorised.
    env.set_auths(&[]);
    assert!(
        vault.try_reserve(&pid(&env, 1), &0).is_err(),
        "an unauthorised caller must not be able to reserve",
    );
    assert_eq!(vault.total_reserved(), 0);

    // ...and the SAME call succeeds once authorisation is restored, so the
    // failure above was the auth check and not some other precondition. Without
    // this half the test would pass even if `reserve` were broken outright.
    env.mock_all_auths();
    assert!(vault.try_reserve(&pid(&env, 1), &0).is_ok());
    assert!(vault.total_reserved() > 0);

    env.set_auths(&[]);
    assert!(
        vault.try_release(&pid(&env, 1), &lp, &0).is_err(),
        "an unauthorised caller must not be able to release a reservation",
    );
}

// ---------------------------------------------------------------------------
// LP shares
// ---------------------------------------------------------------------------

#[test]
fn the_first_lp_gets_shares_one_for_one() {
    let f = setup();
    let lp = lp_with(&f, 500_000_000);
    let minted = f.vault.deposit_liquidity(&lp, &500_000_000);
    assert_eq!(minted, 500_000_000);
    assert_eq!(f.vault.shares_of(&lp), 500_000_000);
    assert_eq!(f.vault.total_shares(), 500_000_000);
}

#[test]
fn a_second_lp_joining_an_unchanged_vault_gets_the_same_rate() {
    let f = setup();
    let a = lp_with(&f, 400_000_000);
    let b = lp_with(&f, 100_000_000);
    f.vault.deposit_liquidity(&a, &400_000_000);
    let minted = f.vault.deposit_liquidity(&b, &100_000_000);
    assert_eq!(minted, 100_000_000);
    assert_eq!(f.vault.total_shares(), 500_000_000);
}

#[test]
fn an_lp_joining_after_the_vault_profited_pays_the_higher_price() {
    // The point of shares. `a` was the counterparty while the vault earned; `b`
    // arrives afterwards and must not be handed a claim on those earnings.
    let f = setup();
    let a = lp_with(&f, 1_000_000);
    f.vault.deposit_liquidity(&a, &1_000_000);

    // A losing trader's forfeited margin arrives as a direct transfer, exactly
    // as `execute_settlement` delivers it.
    f.asset_admin.mint(&f.vault.address, &1_000_000);
    assert_eq!(f.vault.balance(), 2_000_000);

    let b = lp_with(&f, 1_000_000);
    let minted = f.vault.deposit_liquidity(&b, &1_000_000);
    assert_eq!(minted, 500_000, "half the shares for the same money, at 2x book value");

    // And `a` still owns two thirds of the vault, which is now worth 3,000,000.
    assert_eq!(f.vault.shares_of(&a), 1_000_000);
    assert_eq!(f.vault.total_shares(), 1_500_000);
}

#[test]
fn an_lp_withdraws_their_pro_rata_slice_including_profit() {
    let f = setup();
    let a = lp_with(&f, 1_000_000);
    f.vault.deposit_liquidity(&a, &1_000_000);
    f.asset_admin.mint(&f.vault.address, &1_000_000); // vault doubles

    let out = f.vault.withdraw_liquidity(&a, &1_000_000);
    assert_eq!(out, 2_000_000, "the sole LP owns the whole vault");
    assert_eq!(f.vault.shares_of(&a), 0);
    assert_eq!(f.vault.balance(), 0);
}

#[test]
fn an_lp_cannot_withdraw_capital_that_is_backing_an_open_position() {
    // LPs are subordinate to open positions. If this succeeded, the reserve
    // would be a suggestion and the invariant would break the moment the
    // position closed in profit.
    let f = setup();
    let unit = tier_max_payout(0).unwrap() - tier_margin(0).unwrap();
    let lp = lp_with(&f, unit);
    f.vault.deposit_liquidity(&lp, &unit);
    f.vault.reserve(&pid(&f.env, 1), &0);

    assert_eq!(
        f.vault.try_withdraw_liquidity(&lp, &unit),
        Err(Ok(Error::WouldBreakReserve)),
    );
    assert!(f.vault.is_solvent());

    // Once the position closes, the same withdrawal goes through.
    f.vault.release(&pid(&f.env, 1), &Address::generate(&f.env), &0);
    assert_eq!(f.vault.withdraw_liquidity(&lp, &unit), unit);
}

#[test]
fn an_lp_cannot_withdraw_more_shares_than_they_hold() {
    let f = setup();
    let a = lp_with(&f, 1_000_000);
    let b = lp_with(&f, 1_000_000);
    f.vault.deposit_liquidity(&a, &1_000_000);
    f.vault.deposit_liquidity(&b, &1_000_000);
    assert_eq!(
        f.vault.try_withdraw_liquidity(&a, &1_500_000),
        Err(Ok(Error::InsufficientShares)),
    );
}

#[test]
fn zero_and_negative_amounts_are_refused_everywhere() {
    let f = setup();
    let lp = lp_with(&f, 1_000_000);
    assert_eq!(f.vault.try_deposit_liquidity(&lp, &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(f.vault.try_deposit_liquidity(&lp, &-1), Err(Ok(Error::InvalidAmount)));
    f.vault.deposit_liquidity(&lp, &1_000_000);
    assert_eq!(f.vault.try_withdraw_liquidity(&lp, &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(
        f.vault.try_release(&pid(&f.env, 1), &Address::generate(&f.env), &-1),
        Err(Ok(Error::InvalidAmount)),
    );
}

// ---------------------------------------------------------------------------
// The invariant across a randomised-ish sequence
// ---------------------------------------------------------------------------

#[test]
fn the_solvency_invariant_survives_an_interleaved_open_close_sequence() {
    // Not a fuzzer, but a sequence that interleaves every operation that can
    // move either side of `balance >= total_reserved`: deposits, withdrawals,
    // opens, profitable closes, losing closes, and a refused open. The
    // invariant is asserted after every single step, because a violation that
    // only shows up at the end is a violation whose cause is already gone.
    let f = setup();
    let pool = Address::generate(&f.env);
    let lp1 = lp_with(&f, 3_000_000_000);
    let lp2 = lp_with(&f, 2_000_000_000);

    let mut open: soroban_sdk::Vec<BytesN<32>> = SdkVec::new(&f.env);
    let check = |f: &Fixture| {
        assert!(f.vault.is_solvent(), "balance {} < reserved {}", f.vault.balance(), f.vault.total_reserved());
        assert!(f.vault.free_balance() >= 0);
    };

    f.vault.deposit_liquidity(&lp1, &3_000_000_000);
    check(&f);

    for tag in 1u8..=4 {
        let id = pid(&f.env, tag);
        f.vault.reserve(&id, &(tag as u32 % TIER_COUNT));
        open.push_back(id);
        check(&f);
    }

    f.vault.deposit_liquidity(&lp2, &2_000_000_000);
    check(&f);

    // Two winners: paid out in full from their own reserves.
    for tag in [1u8, 2u8] {
        let id = pid(&f.env, tag);
        let reserved = f.vault.reservation_of(&id);
        f.vault.release(&id, &pool, &reserved);
        check(&f);
    }

    // One loser: reserve freed, and the pool sends the forfeited margin over.
    let id = pid(&f.env, 3);
    f.vault.release(&id, &pool, &0);
    f.asset_admin.mint(&f.vault.address, &tier_margin(1).unwrap());
    check(&f);

    // An LP exits for as much as the remaining reserve allows.
    let free = f.vault.free_balance();
    assert!(free > 0);
    let shares = f.vault.shares_of(&lp2);
    let value = f.vault.balance() * shares / f.vault.total_shares();
    if value <= free {
        f.vault.withdraw_liquidity(&lp2, &shares);
    }
    check(&f);

    // The last position closes; everything is unreserved again.
    let id = pid(&f.env, 4);
    f.vault.release(&id, &pool, &0);
    check(&f);
    assert_eq!(f.vault.total_reserved(), 0);
}

#[test]
fn reservations_view_reports_what_is_held() {
    let f = setup();
    let lp = lp_with(&f, 10_000_000_000);
    f.vault.deposit_liquidity(&lp, &10_000_000_000);
    f.vault.reserve(&pid(&f.env, 1), &0);

    let mut ids: soroban_sdk::Vec<BytesN<32>> = SdkVec::new(&f.env);
    ids.push_back(pid(&f.env, 1));
    ids.push_back(pid(&f.env, 2));
    let map = f.vault.reservations(&ids);
    assert_eq!(map.get(pid(&f.env, 1)).unwrap(), tier_max_payout(0).unwrap() - tier_margin(0).unwrap());
    assert_eq!(map.get(pid(&f.env, 2)).unwrap(), 0, "unknown ids read zero, not absent");
}

#[test]
fn double_init_fails() {
    let f = setup();
    let a = Address::generate(&f.env);
    assert_eq!(f.vault.try_initialize(&a, &a, &a), Err(Ok(Error::AlreadyInitialized)));
}
