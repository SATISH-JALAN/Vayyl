#![no_std]

use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// Circuit identifiers for different proof types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CircuitId {
    Deposit,
    Transfer,
    Withdraw,
    PositionOpen,
    PositionHealth,
    PositionClose,
    LiquidationHeartbeat,
    HiddenOrderTrigger,
    MultiLegBasket,
    AspMembership,
    AspNonMembership,
    SealedOrder,
}

/// Verification key components for Groth16/BN254
#[contracttype]
#[derive(Clone, Debug)]
pub struct VerificationKey {
    pub alpha_g1: BytesN<64>,
    pub beta_g2: BytesN<128>,
    pub gamma_g2: BytesN<128>,
    pub delta_g2: BytesN<128>,
    pub ic: Vec<BytesN<64>>,
}

/// Proof components for Groth16/BN254
#[contracttype]
#[derive(Clone, Debug)]
pub struct Groth16Proof {
    pub a: BytesN<64>,
    pub b: BytesN<128>,
    pub c: BytesN<64>,
}

/// The internal state of a derivative position
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionState {
    /// The owner of the position
    pub owner: Address,
    /// The current ZK commitment binding collateral, size, direction, and entry price
    pub commitment: BytesN<32>,
    /// The last time health was attested
    pub last_health_timestamp: u64,
}

/// The internal state of a hidden order
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderState {
    pub owner: Address,
    pub commitment: BytesN<32>,
    pub escrowed_amount: i128,
}
