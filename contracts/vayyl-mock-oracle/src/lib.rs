#![no_std]

//! A SEP-40 price feed for testnet.
//!
//! Why this exists in the repo at all. The position contracts previously talked
//! to a `get_last_price() -> (i128, u64)` shape that matched no standard and
//! whose only implementation was a two-line stub inside a `#[cfg(test)]` module.
//! Nothing outside the test binary could produce that shape, so the deployed
//! oracle address was effectively unspecified — the one input that decides
//! whether a position is solvent had no definition anyone could check.
//!
//! This implements the real SEP-40 `lastprice(asset)` surface (the interface
//! Reflector serves on mainnet), so the same client code, the same adapter and
//! the same staleness rules work against either. On testnet an admin pushes
//! prices; on mainnet the same call goes to Reflector unchanged.
//!
//! Units. `price` is stroops of the collateral asset per contract unit, which is
//! what makes `size * price` come out in stroops and lets the settlement
//! arithmetic in `position_close.circom` stay integer and scale-free. It is NOT
//! the 14-decimal USD quote Reflector publishes; a real deployment converts
//! once, in the adapter, rather than teaching every circuit about decimals.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Vec};

// The SEP-40 shapes live in `vayyl-types` so the oracle, the position manager
// and the keeper cannot drift apart on the key a price is stored under.
pub use vayyl_types::{Asset, PriceData};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Decimals,
    Resolution,
    Price(Asset),
    Assets,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    /// A price must be strictly positive: zero would make every notional zero
    /// and every position trivially "healthy".
    InvalidPrice = 3,
    /// The pushed timestamp is in the future relative to the ledger. Accepting
    /// it would let one push make a position unliquidatable for as long as the
    /// gap lasts.
    TimestampInFuture = 4,
}

const TTL_THRESHOLD: u32 = 500_000;
const TTL_EXTEND: u32 = 1_000_000;

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn initialize(env: Env, admin: Address, decimals: u32, resolution: u32) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Resolution, &resolution);
        env.storage().instance().set(&DataKey::Assets, &Vec::<Asset>::new(&env));
        Ok(())
    }

    /// Publish a price. Admin-gated; testnet only.
    ///
    /// The timestamp is taken from the LEDGER, not from the caller. An admin who
    /// could name the timestamp could backdate a price to force liquidations, or
    /// forward-date one to block them — and the consumers' staleness checks
    /// would then be measuring a number that same party chose.
    pub fn set_price(env: Env, asset: Asset, price: i128) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if price <= 0 {
            return Err(Error::InvalidPrice);
        }

        let record = PriceData { price, timestamp: env.ledger().timestamp() };
        env.storage().persistent().set(&DataKey::Price(asset.clone()), &record);
        env.storage().persistent().extend_ttl(
            &DataKey::Price(asset.clone()),
            TTL_THRESHOLD,
            TTL_EXTEND,
        );

        let mut assets: Vec<Asset> = env
            .storage()
            .instance()
            .get(&DataKey::Assets)
            .unwrap_or(Vec::new(&env));
        if !assets.contains(&asset) {
            assets.push_back(asset);
            env.storage().instance().set(&DataKey::Assets, &assets);
        }
        env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
        Ok(())
    }

    /// Publish a price with an explicit timestamp. Test and simulation only.
    ///
    /// Kept separate from `set_price`, and deliberately unable to move time
    /// forward: staleness tests need to produce an OLD price, while a contract
    /// that let an admin produce a FUTURE one would hand them a liquidation
    /// freeze.
    pub fn set_price_at(env: Env, asset: Asset, price: i128, timestamp: u64) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if price <= 0 {
            return Err(Error::InvalidPrice);
        }
        if timestamp > env.ledger().timestamp() {
            return Err(Error::TimestampInFuture);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Price(asset), &PriceData { price, timestamp });
        Ok(())
    }

    /// SEP-40: the most recent price for `asset`, or `None` if never published.
    ///
    /// `None` rather than a zero record, on purpose. A caller that receives zero
    /// and does not special-case it computes a zero notional, and a zero
    /// notional makes every position pass its health check.
    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        env.storage().persistent().get(&DataKey::Price(asset))
    }

    /// SEP-40: decimal places of the quote.
    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimals).unwrap_or(7)
    }

    /// SEP-40: nominal update interval, in seconds.
    pub fn resolution(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Resolution).unwrap_or(60)
    }

    /// SEP-40: every asset this feed has published.
    pub fn assets(env: Env) -> Vec<Asset> {
        env.storage().instance().get(&DataKey::Assets).unwrap_or(Vec::new(&env))
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Symbol;

    fn setup(env: &Env) -> (MockOracleClient<'static>, Asset) {
        env.mock_all_auths();
        let id = env.register(MockOracle, ());
        let client = MockOracleClient::new(env, &id);
        client.initialize(&Address::generate(env), &7, &60);
        (client, Asset::Other(Symbol::new(env, "XLM")))
    }

    #[test]
    fn an_unpublished_asset_reads_none_not_zero() {
        let env = Env::default();
        let (client, xlm) = setup(&env);
        assert_eq!(client.lastprice(&xlm), None);
    }

    #[test]
    fn a_published_price_carries_ledger_time() {
        let env = Env::default();
        env.ledger().set_timestamp(1_000);
        let (client, xlm) = setup(&env);
        client.set_price(&xlm, &10_000_000);
        let got = client.lastprice(&xlm).unwrap();
        assert_eq!(got.price, 10_000_000);
        assert_eq!(got.timestamp, 1_000, "the ledger's time, never the caller's");
    }

    #[test]
    fn republishing_moves_the_timestamp_forward_with_the_ledger() {
        // This is what makes a downstream staleness check mean anything: if the
        // record's timestamp did not track the ledger, "fresh" would be a
        // property of the write, not of the price.
        let env = Env::default();
        env.ledger().set_timestamp(1_000);
        let (client, xlm) = setup(&env);
        client.set_price(&xlm, &10_000_000);
        env.ledger().set_timestamp(5_000);
        client.set_price(&xlm, &11_000_000);
        assert_eq!(client.lastprice(&xlm).unwrap().timestamp, 5_000);
    }

    #[test]
    fn a_future_dated_price_is_refused() {
        // A future timestamp reads as "fresher than now" to every staleness
        // check, so one push would make positions unliquidatable until the
        // ledger caught up.
        let env = Env::default();
        env.ledger().set_timestamp(1_000);
        let (client, xlm) = setup(&env);
        assert!(client.try_set_price_at(&xlm, &10_000_000, &2_000).is_err());
        assert!(client.try_set_price_at(&xlm, &10_000_000, &1_000).is_ok());
    }

    #[test]
    fn a_non_positive_price_is_refused() {
        let env = Env::default();
        let (client, xlm) = setup(&env);
        assert!(client.try_set_price(&xlm, &0).is_err());
        assert!(client.try_set_price(&xlm, &-1).is_err());
    }

    #[test]
    fn published_assets_are_enumerable_and_deduplicated() {
        let env = Env::default();
        let (client, xlm) = setup(&env);
        client.set_price(&xlm, &10_000_000);
        client.set_price(&xlm, &10_500_000);
        assert_eq!(client.assets().len(), 1);
    }

    #[test]
    fn double_init_fails() {
        let env = Env::default();
        let (client, _) = setup(&env);
        assert!(client.try_initialize(&Address::generate(&env), &7, &60).is_err());
    }
}
