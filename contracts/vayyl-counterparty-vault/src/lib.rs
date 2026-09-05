#![no_std]

//! The counterparty vault.
//!
//! Every derivative needs someone on the other side. In a public perp that
//! someone is visible and their solvency is checkable by inspection. In a
//! shielded perp the positions are commitments, so "can the protocol pay what it
//! owes?" is a question nobody can answer by looking — which is exactly the
//! situation in which a protocol discovers it is insolvent only when a winner
//! tries to withdraw.
//!
//! This contract turns that question into an on-chain invariant:
//!
//! ```text
//!     vault_balance  >=  Σ over open positions of (max_payout(tier) - margin(tier))
//! ```
//!
//! Anyone can check it at any ledger, without opening a single commitment,
//! because `max_payout` and `margin` are tier constants rather than private
//! amounts. That is the whole reason positions are tiered (see
//! `vayyl_types::TIER_MARGIN` for the privacy half of the same argument).
//!
//! The safety property is `reserve()` FAILING. A position may only open if the
//! money for its best case already exists and has been set aside; when the vault
//! is short, the correct outcome is that the position cannot be opened. That is
//! a normal state, not an error condition — the UI is required to say so in
//! those terms.
//!
//! What this contract deliberately does NOT do:
//!
//! - It does not hold or move margin. Trader collateral lives in the pool as a
//!   shielded note and never leaves it; the vault only ever funds *profit* owed
//!   beyond that margin. Keeping the two custody surfaces apart means a bug here
//!   cannot reach user deposits.
//! - It does not price anything. It knows tier constants and balances. Every
//!   oracle decision belongs to `PositionManager`.
//!
//! LP deposits are PUBLIC on testnet. That leaks vault size and flow, and is a
//! known, accepted limitation: shielding the LP side needs its own circuit and
//! would gate everything else behind it. It is documented rather than hidden.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, Map,
};
use vayyl_types::tier_reserve;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// SAC address of the asset this vault is denominated in.
    Asset,
    /// The only contract allowed to reserve and release.
    PositionManager,
    /// position_id -> amount currently set aside for it.
    Reservation(BytesN<32>),
    /// Σ of all live reservations. Kept as a running total rather than derived,
    /// because deriving it would mean iterating every open position on every
    /// call and Soroban has no way to enumerate persistent keys.
    TotalReserved,
    /// LP address -> shares.
    Shares(Address),
    TotalShares,
}

#[contractevent]
pub struct LiquidityAdded {
    #[topic]
    pub lp: Address,
    pub amount: i128,
    pub shares: i128,
}

#[contractevent]
pub struct LiquidityRemoved {
    #[topic]
    pub lp: Address,
    pub amount: i128,
    pub shares: i128,
}

#[contractevent]
pub struct Reserved {
    #[topic]
    pub position_id: BytesN<32>,
    pub amount: i128,
    pub total_reserved: i128,
}

#[contractevent]
pub struct Released {
    #[topic]
    pub position_id: BytesN<32>,
    pub freed: i128,
    pub paid_out: i128,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    /// Amount is zero or negative.
    InvalidAmount = 3,
    /// `tier_id` is not in the tier table.
    UnknownTier = 4,
    /// The vault cannot cover this position's best case. NOT a failure of the
    /// protocol — it means the counterparty is full.
    InsufficientLiquidity = 5,
    /// A reservation already exists for this position id.
    AlreadyReserved = 6,
    /// No reservation exists for this position id.
    NotReserved = 7,
    /// A payout larger than what was set aside for this position. Refusing is
    /// what stops one position's settlement from consuming another's reserve.
    PayoutExceedsReservation = 8,
    /// The LP is trying to remove more shares than they hold.
    InsufficientShares = 9,
    /// The withdrawal is covered by shares but not by unreserved cash. LPs are
    /// subordinate to open positions by design.
    WouldBreakReserve = 10,
}

const TTL_THRESHOLD: u32 = 500_000;
const TTL_EXTEND: u32 = 1_000_000;

fn extend_instance(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}

#[contract]
pub struct CounterpartyVault;

#[contractimpl]
impl CounterpartyVault {
    pub fn initialize(
        env: Env,
        admin: Address,
        asset: Address,
        position_manager: Address,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Asset) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Asset, &asset);
        env.storage()
            .instance()
            .set(&DataKey::PositionManager, &position_manager);
        env.storage().instance().set(&DataKey::TotalReserved, &0i128);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        extend_instance(&env);
        Ok(())
    }

    // ---- accounting views --------------------------------------------------

    /// Everything the vault holds, reserved or not.
    ///
    /// Read from the token contract rather than from an internal counter. An
    /// internal counter would drift from reality the first time anyone sent the
    /// vault tokens directly — and a settling position pays the vault exactly
    /// that way, by `execute_settlement` naming the vault as payout recipient.
    /// The balance IS the truth; there is no second bookkeeping to disagree
    /// with it.
    pub fn balance(env: Env) -> Result<i128, Error> {
        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(Error::NotInitialized)?;
        Ok(token::Client::new(&env, &asset).balance(&env.current_contract_address()))
    }

    pub fn total_reserved(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalReserved).unwrap_or(0)
    }

    /// What is available to back a NEW position, or to be withdrawn by an LP.
    ///
    /// Saturating at zero rather than going negative: a negative free balance is
    /// not a number any caller can act on, and returning one invites a signed
    /// comparison somewhere else to read it as "plenty".
    pub fn free_balance(env: Env) -> Result<i128, Error> {
        let balance = Self::balance(env.clone())?;
        let reserved = Self::total_reserved(env);
        Ok(if balance > reserved { balance - reserved } else { 0 })
    }

    /// The invariant, as a single boolean anyone can call.
    pub fn is_solvent(env: Env) -> Result<bool, Error> {
        Ok(Self::balance(env.clone())? >= Self::total_reserved(env))
    }

    pub fn reservation_of(env: Env, position_id: BytesN<32>) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Reservation(position_id))
            .unwrap_or(0)
    }

    pub fn shares_of(env: Env, lp: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Shares(lp)).unwrap_or(0)
    }

    pub fn total_shares(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0)
    }

    // ---- liquidity ---------------------------------------------------------

    /// Fund the vault and receive shares proportional to what is already there.
    ///
    /// Shares rather than a flat ledger of deposits, because the vault's value
    /// moves: it pays winning positions and collects from losing ones. A flat
    /// ledger would let the last LP out take a full nominal balance while an
    /// earlier one absorbed the losses — first-come-first-served on a shared
    /// pot. Pro-rata shares make every LP hold the same fraction of whatever the
    /// vault turns out to be worth.
    pub fn deposit_liquidity(env: Env, lp: Address, amount: i128) -> Result<i128, Error> {
        lp.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(Error::NotInitialized)?;

        // Priced BEFORE the transfer: pricing after would let the depositor's
        // own funds inflate the denominator and mint them fewer shares than
        // they paid for.
        let balance_before = Self::balance(env.clone())?;
        let total_shares = Self::total_shares(env.clone());
        let minted = if total_shares == 0 || balance_before == 0 {
            amount
        } else {
            amount * total_shares / balance_before
        };
        if minted <= 0 {
            return Err(Error::InvalidAmount);
        }

        token::Client::new(&env, &asset).transfer(
            &lp,
            &env.current_contract_address(),
            &amount,
        );

        let key = DataKey::Shares(lp.clone());
        let held: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(held + minted));
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &(total_shares + minted));
        extend_instance(&env);

        LiquidityAdded { lp, amount, shares: minted }.publish(&env);
        Ok(minted)
    }

    /// Redeem shares for their pro-rata slice of the vault.
    ///
    /// Bounded by `free_balance`, never by the raw balance. LPs are subordinate
    /// to open positions: the money set aside for a trader's best case is not
    /// available to the people who put it there, or the reserve would be a
    /// suggestion. An LP wanting out of a fully-reserved vault waits for
    /// positions to close, which is the risk being paid for.
    pub fn withdraw_liquidity(env: Env, lp: Address, shares: i128) -> Result<i128, Error> {
        lp.require_auth();
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(Error::NotInitialized)?;

        let key = DataKey::Shares(lp.clone());
        let held: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if shares > held {
            return Err(Error::InsufficientShares);
        }

        let total_shares = Self::total_shares(env.clone());
        let balance = Self::balance(env.clone())?;
        let amount = balance * shares / total_shares;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if amount > Self::free_balance(env.clone())? {
            return Err(Error::WouldBreakReserve);
        }

        env.storage().persistent().set(&key, &(held - shares));
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &(total_shares - shares));
        extend_instance(&env);

        token::Client::new(&env, &asset).transfer(&env.current_contract_address(), &lp, &amount);

        LiquidityRemoved { lp, amount, shares }.publish(&env);
        Ok(amount)
    }

    // ---- reservations ------------------------------------------------------

    fn assert_manager(env: &Env) -> Result<Address, Error> {
        let pm: Address = env
            .storage()
            .instance()
            .get(&DataKey::PositionManager)
            .ok_or(Error::NotInitialized)?;
        pm.require_auth();
        Ok(pm)
    }

    /// Set aside the profit this position could win beyond its own margin.
    ///
    /// Called by `PositionManager::open_position` BEFORE proof verification, so
    /// the cheap check that can fail for an ordinary reason runs before the
    /// expensive one that should not fail at all.
    pub fn reserve(env: Env, position_id: BytesN<32>, tier_id: u32) -> Result<i128, Error> {
        Self::assert_manager(&env)?;

        let key = DataKey::Reservation(position_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyReserved);
        }
        let amount = tier_reserve(tier_id).ok_or(Error::UnknownTier)?;
        if amount > Self::free_balance(env.clone())? {
            return Err(Error::InsufficientLiquidity);
        }

        env.storage().persistent().set(&key, &amount);
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        let total = Self::total_reserved(env.clone()) + amount;
        env.storage().instance().set(&DataKey::TotalReserved, &total);
        extend_instance(&env);

        Reserved { position_id, amount, total_reserved: total }.publish(&env);
        Ok(amount)
    }

    /// Free a position's reservation, optionally paying part of it out.
    ///
    /// `payout` is the profit owed beyond the trader's margin, which the pool
    /// then mints as part of the trader's shielded output note. It is capped at
    /// the reservation for this specific position: without that cap a settlement
    /// could reach into the money set aside for someone else's position, which
    /// is the failure mode reserving exists to prevent.
    ///
    /// A losing position releases with `payout = 0` — the vault keeps its
    /// reserve and separately receives the trader's forfeited margin from the
    /// pool, which is how LPs are paid.
    pub fn release(
        env: Env,
        position_id: BytesN<32>,
        recipient: Address,
        payout: i128,
    ) -> Result<i128, Error> {
        Self::assert_manager(&env)?;
        if payout < 0 {
            return Err(Error::InvalidAmount);
        }

        let key = DataKey::Reservation(position_id.clone());
        let reserved: i128 = env.storage().persistent().get(&key).ok_or(Error::NotReserved)?;
        if payout > reserved {
            return Err(Error::PayoutExceedsReservation);
        }

        // Accounting first, transfer last. A re-entered call finds no
        // reservation and fails at `NotReserved`, so the same reserve cannot be
        // paid out twice.
        env.storage().persistent().remove(&key);
        let total = Self::total_reserved(env.clone()) - reserved;
        env.storage().instance().set(&DataKey::TotalReserved, &total);
        extend_instance(&env);

        if payout > 0 {
            let asset: Address = env
                .storage()
                .instance()
                .get(&DataKey::Asset)
                .ok_or(Error::NotInitialized)?;
            token::Client::new(&env, &asset).transfer(
                &env.current_contract_address(),
                &recipient,
                &payout,
            );
        }

        Released { position_id, freed: reserved, paid_out: payout }.publish(&env);
        Ok(reserved)
    }

    // ---- admin -------------------------------------------------------------

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)
    }

    pub fn position_manager(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::PositionManager)
            .ok_or(Error::NotInitialized)
    }

    /// Repoint the vault at a new PositionManager (after a manager upgrade that
    /// changes its address). Admin-gated.
    pub fn set_position_manager(env: Env, position_manager: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::PositionManager, &position_manager);
        extend_instance(&env);
        Ok(())
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Debug view: the reservations this contract knows about, for a caller who
    /// already has the ids. Soroban cannot enumerate persistent keys, so the
    /// caller supplies them; the indexer has the full list from `Reserved`
    /// events.
    pub fn reservations(env: Env, position_ids: soroban_sdk::Vec<BytesN<32>>) -> Map<BytesN<32>, i128> {
        let mut out = Map::new(&env);
        for id in position_ids.iter() {
            out.set(id.clone(), Self::reservation_of(env.clone(), id));
        }
        out
    }
}

#[cfg(test)]
mod test;
