#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        to.require_auth();
        // Since it's a mock, we could use the standard stellar asset contract
        // or just dummy it if we only use it for integration tests.
        // Actually, the easiest way to test tokens is deploying the built-in SAC.
    }
}
