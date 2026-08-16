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
    /// V2 public exit (`ragequit_v2.circom`). APPEND-ONLY: this enum's order is
    /// the numeric circuit ID used when registering verification keys on-chain,
    /// so inserting above this line silently repoints every later VK.
    RageQuit,
    /// V3 arbitrary-amount deposit (`deposit_v3.circom`), 3 public inputs.
    /// Separate from `Deposit` rather than replacing it: the V2 slot is live on
    /// testnet with a 2-input key, and the verifier rejects on `ic.len()`
    /// mismatch, so overwriting it would break every V2 note still in the pool.
    DepositV3,
    /// V3 2-in/2-out arbitrary-amount transfer (`transfer_v3.circom`), 9 inputs.
    TransferV3,
    /// V3 arbitrary-amount withdraw (`withdraw_v3.circom`), 4 public inputs.
    WithdrawV3,
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
