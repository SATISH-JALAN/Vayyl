#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Price,
    Timestamp,
}

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn set_price(env: Env, price: i128, timestamp: u64) {
        env.storage().instance().set(&DataKey::Price, &price);
        env.storage().instance().set(&DataKey::Timestamp, &timestamp);
    }

    pub fn get_last_price(env: Env) -> (i128, u64) {
        let price: i128 = env.storage().instance().get(&DataKey::Price).unwrap_or(0);
        let timestamp: u64 = env.storage().instance().get(&DataKey::Timestamp).unwrap_or(0);
        (price, timestamp)
    }
}
