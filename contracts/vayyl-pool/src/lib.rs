#![no_std]

use soroban_poseidon::poseidon2_hash;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, log, token, Address,
    BytesN, Env, Vec,
};
use vayyl_types::{CircuitId, Groth16Proof};

/// C4: deposit event — topic `deposit` + the commitment; data carries the
/// leaf index (for Merkle-path reconstruction) and the public amount.
#[contractevent]
pub struct Deposit {
    #[topic]
    pub commitment: BytesN<32>,
    pub leaf_index: u32,
    pub amount: i128,
}

/// V2 shielded transfer: one 1-XLM note is spent and one is created for a
/// recipient only they can identify. `ephemeral_*` is the sender's one-time
/// BabyJubjub point R — the recipient recovers the new note's blindness as
/// `Poseidon2((spendKey·R).x, 0)` and finds the note by trial-matching the
/// commitment, so no ciphertext and no out-of-band message are needed.
///
/// `leaf_index` is load-bearing, not informational: without it the indexer
/// cannot place this commitment in the tree, and an unplaceable commitment
/// corrupts the leaf ordering every client rebuilds its Merkle paths from.
/// The retired V1 `Transfer` event omitted it, which is exactly that bug.
///
/// The topic string is pinned rather than derived, because the indexer routes
/// on it and the SDK's default is `to_snake_case(StructName)`.
#[contractevent(topics = ["transfer_v2"])]
pub struct TransferV2 {
    #[topic]
    pub nullifier: BytesN<32>,
    pub commitment: BytesN<32>,
    pub leaf_index: u32,
    pub ephemeral_x: BytesN<32>,
    pub ephemeral_y: BytesN<32>,
    pub amount: i128,
}

/// C4: withdraw event — topic `withdraw` + the spent nullifier; data carries
/// the public recipient and amount.
#[contractevent]
pub struct Withdraw {
    #[topic]
    pub nullifier: BytesN<32>,
    pub recipient: Address,
    pub amount: i128,
}

/// V2 public exit. Unlike `Withdraw`, this event carries the `commitment` as
/// well as the nullifier, and that is the entire point: rage-quit trades privacy
/// for liquidity, so the link between the original deposit and the payout
/// address is published on purpose. An observer can join this to the `Deposit`
/// event bearing the same commitment and see the full path in and out.
///
/// Pinned topic string because the indexer routes on it and the SDK default is
/// `to_snake_case(StructName)`.
#[contractevent(topics = ["ragequit_v2"])]
pub struct RageQuit {
    #[topic]
    pub nullifier: BytesN<32>,
    pub commitment: BytesN<32>,
    pub recipient: Address,
    pub amount: i128,
}

/// D1: settlement event — topic `authority` (the settlement contract that drove
/// it); data carries how many output commitments were inserted and the public
/// payout amount (0 for a pure re-shield). Lets the indexer / client note-scan
/// pick up notes created by position close, liquidation seizure, orders, etc.
#[contractevent]
pub struct Settlement {
    #[topic]
    pub authority: Address,
    pub num_commitments: u32,
    pub payout_amount: i128,
}

#[soroban_sdk::contractclient(name = "Groth16VerifierClient")]
pub trait Groth16VerifierInterface {
    fn verify(
        env: Env,
        circuit_id: CircuitId,
        proof: Groth16Proof,
        public_inputs: Vec<BytesN<32>>,
    ) -> Result<bool, soroban_sdk::Error>;
}

/// Decoupled client for the trusted `AspMembership` contract. The pool binds a
/// deposit's caller-supplied `asp_root` to a real, admin-maintained ASP root via
/// `is_known_root` — the deposit circuit proves membership *against* `asp_root`,
/// and this call guarantees `asp_root` is the trusted set's root (current or
/// recent), not one the depositor invented. Mirrors `Groth16VerifierInterface`.
#[soroban_sdk::contractclient(name = "AspMembershipClient")]
pub trait AspMembershipInterface {
    fn is_known_root(env: Env, root: BytesN<32>) -> bool;
}

/// Decoupled client for the ASP blocklist contract. On transfer/withdraw the
/// pool rejects nullifiers the blocklist marks as blocked. If the non-membership
/// contract is not yet initialized (no `Admin` key), the check is skipped so
/// older deployments keep working until the admin wires a real blocklist.
#[soroban_sdk::contractclient(name = "AspNonMembershipClient")]
pub trait AspNonMembershipInterface {
    fn is_not_blocked(env: Env, leaf: BytesN<32>) -> bool;
    fn admin(env: Env) -> Result<Address, soroban_sdk::Error>;
}

pub const TREE_DEPTH: u32 = 20;

/// H4: how many recent Merkle roots stay valid for in-flight proofs.
/// A withdraw/transfer proof is accepted if the root it was built against is
/// the current root or any of the last `ROOT_HISTORY_SIZE` roots. This absorbs
/// concurrent deposits landing between proof-generation and submission.
pub const ROOT_HISTORY_SIZE: u32 = 32;

/// Vault V2 uses one denomination per pool. The circuit hard-codes the same
/// value, so neither deposit nor withdrawal accepts an amount chosen by a user.
pub const V2_DENOMINATION: i128 = 10_000_000;

/// H3: nullifier / tree persistence TTL. We extend to `PERSISTENT_TTL_EXTEND`
/// whenever the remaining TTL drops below `PERSISTENT_TTL_THRESHOLD`, on every
/// touch, so a spent-nullifier entry survives far past the old ~100k window.
/// `PERSISTENT_TTL_EXTEND` is kept under the mainnet `max_entry_ttl`
/// (~3.11M ledgers ≈ 6 months); the host traps if we exceed the network max.
/// NOTE: Soroban has no truly-infinite TTL — genuine permanence requires either
/// a keeper that re-extends, or the archived-entry restore proof on spend. This
/// maximises the window; full permanence is tracked in §7 (client hardening).
pub const PERSISTENT_TTL_THRESHOLD: u32 = 1_000_000;
pub const PERSISTENT_TTL_EXTEND: u32 = 3_000_000;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin authorized to `upgrade()` this pool in place.
    Admin,
    Asset,
    Verifier,
    Membership,
    NonMembership,
    /// Presence of this key switches a fresh deployment into fixed-denomination
    /// Vault V2 mode. Mainnet V1 deployments do not have this key.
    Denomination,
    TreeNextIndex,
    TreeFrontier,
    TreeRoot,
    TreeZeros,
    /// H4: ring buffer of the last `ROOT_HISTORY_SIZE` roots (oldest first).
    RootHistory,
    Nullifier(BytesN<32>),
    Commitment(BytesN<32>),
    /// D1: allowlist of contracts permitted to call `execute_settlement`
    /// (position-manager, liquidation-engine, and later the order/agentic hubs).
    /// Admin-managed. Presence of the key = authorized.
    SettlementAuthority(Address),
    /// Whether spends consult the ASP blocklist. **Absent means enabled**, so a
    /// pool that is upgraded and never configured enforces by default; disabling
    /// is an explicit, visible admin decision. See `assert_nullifier_not_blocked`.
    BlocklistEnabled,
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidProof = 3,
    NullifierAlreadyUsed = 4,
    TreeFull = 5,
    /// H4: proof was built against a root no longer in the historical window.
    UnknownRoot = 6,
    /// M2: amount/fee is negative (non-encodable as a field element).
    InvalidAmount = 7,
    /// C3: deposit `asp_root` is not the trusted AspMembership root (current or
    /// in-window). The depositor supplied a root the ASP contract never produced.
    InvalidAspRoot = 8,
    /// D1: `execute_settlement` caller is not on the admin-managed settlement
    /// authority allowlist.
    NotSettlementAuthority = 9,
    /// A spent nullifier is on the ASP blocklist (non-membership enforcement).
    NullifierBlocked = 10,
    WrongPoolMode = 11,
    CommitmentAlreadyExists = 12,
    /// `ragequit_v2` was given a commitment this pool never accepted. Rage-quit
    /// checks inclusion by key lookup rather than by Merkle proof, so an unknown
    /// commitment is rejected here instead of failing proof verification.
    UnknownCommitment = 13,
    /// Blocklist enforcement is enabled but the non-membership contract could
    /// not be consulted. Rejecting is deliberate: an unavailable compliance
    /// check is an unmet one, and the pool must not report success for a check
    /// it never performed. Note this never traps funds — `ragequit_v2` does not
    /// consult the blocklist and remains available.
    BlocklistUnavailable = 14,
}

#[contract]
pub struct VayylPool;

/// Compute a Poseidon2 hash of two 32-byte inputs, returning a 32-byte output.
/// This wraps the native Soroban `poseidon2_hash` host function.
fn hash2(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    let left_bytes: soroban_sdk::Bytes = left.clone().into();
    let right_bytes: soroban_sdk::Bytes = right.clone().into();
    // Reduce to the canonical field representative (< BN254 modulus) before
    // hashing. poseidon2_hash panics on any input >= the modulus, and ~1/8 of
    // arbitrary 32-byte values (user commitments, SHA-256 outputs) exceed it.
    // Bn254Fr::from_u256(..).to_u256() applies the field's own reduction, which
    // matches how the Circom circuit interprets these signals (value mod p).
    let left_u256 = soroban_sdk::crypto::bn254::Bn254Fr::from_u256(
        soroban_sdk::U256::from_be_bytes(env, &left_bytes),
    )
    .to_u256();
    let right_u256 = soroban_sdk::crypto::bn254::Bn254Fr::from_u256(
        soroban_sdk::U256::from_be_bytes(env, &right_bytes),
    )
    .to_u256();

    let mut inputs = soroban_sdk::Vec::new(env);
    inputs.push_back(left_u256);
    inputs.push_back(right_u256);

    let result = poseidon2_hash::<3, soroban_sdk::crypto::bn254::Bn254Fr>(env, &inputs);
    let bytes = result.to_be_bytes();
    let mut array = [0u8; 32];

    let copy_len = array.len().min(bytes.len() as usize);
    bytes
        .slice(0..copy_len as u32)
        .copy_into_slice(&mut array[32 - copy_len..]);

    BytesN::from_array(env, &array)
}

/// Reject nullifiers on the ASP blocklist.
///
/// **This check fails closed.** The previous implementation inferred whether a
/// blocklist was "really" wired by comparing the non-membership address against
/// the verifier/membership addresses and by probing `admin()`, returning
/// `Ok(())` whenever either heuristic said no. Both inferences silently turned
/// enforcement off: a placeholder address, a not-yet-initialized contract, or a
/// transient failure of the `admin()` call all read as "blocklist disabled", and
/// nothing on-chain or in any event distinguished that from a nullifier that had
/// genuinely been checked and cleared. A compliance control that reports success
/// when it did not run is worse than no control at all, because it gets claimed.
///
/// Enforcement is now an explicit, inspectable state. `DataKey::BlocklistEnabled`
/// is set by the admin via `set_blocklist_enabled`, readable by anyone via
/// `blocklist_enabled()`, and **absent means enabled** — so an upgraded pool that
/// has never been configured enforces rather than quietly waves spends through.
/// Turning it off is a deliberate admin action recorded on the ledger.
///
/// If the blocklist is enabled but cannot be consulted (address never
/// initialized, wrong contract wired, call reverts), the spend is REJECTED with
/// `BlocklistUnavailable` rather than allowed. That is the whole point of
/// failing closed: an unavailable check is an unmet check.
fn assert_nullifier_not_blocked(env: &Env, nullifier: &BytesN<32>) -> Result<(), Error> {
    if !blocklist_is_enabled(env) {
        return Ok(());
    }
    let nm_addr: Address = env
        .storage()
        .instance()
        .get(&DataKey::NonMembership)
        .ok_or(Error::NotInitialized)?;
    let nm_client = AspNonMembershipClient::new(env, &nm_addr);
    match nm_client.try_is_not_blocked(nullifier) {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(Error::NullifierBlocked),
        // Either the cross-contract call itself failed (no such contract, no
        // such function, contract not initialized) or it returned a value we
        // could not read. Both mean the blocklist did not answer.
        _ => Err(Error::BlocklistUnavailable),
    }
}

/// Blocklist enforcement state. Absent = enabled, so the safe behaviour is the
/// one you get by doing nothing, including across an in-place `upgrade()`.
fn blocklist_is_enabled(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::BlocklistEnabled)
        .unwrap_or(true)
}

#[contractimpl]
impl VayylPool {
    /// Initialize the Vayyl Pool with the underlying asset and external contract references
    pub fn initialize(
        env: Env,
        admin: Address,
        asset: Address,
        verifier: Address,
        membership: Address,
        non_membership: Address,
    ) -> Result<(), Error> {
        Self::initialize_state(
            &env,
            admin,
            asset,
            verifier,
            membership,
            non_membership,
            false,
        )
    }

    /// Initialize a separate fixed-denomination Vault V2 deployment.
    pub fn initialize_v2(
        env: Env,
        admin: Address,
        asset: Address,
        verifier: Address,
        membership: Address,
        non_membership: Address,
    ) -> Result<(), Error> {
        Self::initialize_state(
            &env,
            admin,
            asset,
            verifier,
            membership,
            non_membership,
            true,
        )
    }

    fn initialize_state(
        env: &Env,
        admin: Address,
        asset: Address,
        verifier: Address,
        membership: Address,
        non_membership: Address,
        v2: bool,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Asset) {
            return Err(Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Asset, &asset);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        env.storage()
            .instance()
            .set(&DataKey::Membership, &membership);
        env.storage()
            .instance()
            .set(&DataKey::NonMembership, &non_membership);
        if v2 {
            env.storage()
                .instance()
                .set(&DataKey::Denomination, &V2_DENOMINATION);
        }

        // Initialize tree state
        env.storage().instance().set(&DataKey::TreeNextIndex, &0u32);

        // Precompute zero hashes for each level of the tree.
        // zeros[0] = 0 (empty leaf)
        // zeros[i] = Poseidon2(zeros[i-1], zeros[i-1])
        let mut zeros: Vec<BytesN<32>> = Vec::new(env);
        let zero_leaf = BytesN::from_array(env, &[0u8; 32]);
        zeros.push_back(zero_leaf.clone());

        let mut current_zero = zero_leaf;
        for _ in 1..=TREE_DEPTH {
            current_zero = hash2(env, &current_zero, &current_zero);
            zeros.push_back(current_zero.clone());
        }
        env.storage().persistent().set(&DataKey::TreeZeros, &zeros);

        // Initialize empty frontier (TREE_DEPTH entries, all unset)
        let empty_frontier: Vec<BytesN<32>> = Vec::new(env);
        env.storage()
            .persistent()
            .set(&DataKey::TreeFrontier, &empty_frontier);

        // Initial root = zeros[TREE_DEPTH] (root of a completely empty tree)
        env.storage()
            .instance()
            .set(&DataKey::TreeRoot, &current_zero);

        log!(
            env,
            "VayylPool initialized. Empty root computed at depth {}",
            TREE_DEPTH
        );

        Ok(())
    }

    fn assert_v1(env: &Env) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Denomination) {
            return Err(Error::WrongPoolMode);
        }
        Ok(())
    }

    fn v2_denomination(env: &Env) -> Result<i128, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Denomination)
            .ok_or(Error::WrongPoolMode)
    }

    /// Insert a leaf into the Merkle tree using frontier-based insertion.
    ///
    /// The frontier stores the "left-most unsettled" node at each level.
    /// When a new leaf arrives:
    /// - Walk up the tree from the leaf level.
    /// - At each level, if the current index bit is 0, this leaf is a LEFT child:
    ///   store it in the frontier and hash with the zero-sibling from the right.
    /// - If the current index bit is 1, this leaf is a RIGHT child:
    ///   pop the frontier value (the left sibling) and hash together.
    /// - Continue up to the root.
    fn insert_leaf(env: &Env, leaf: BytesN<32>) -> Result<BytesN<32>, Error> {
        let index: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TreeNextIndex)
            .unwrap_or(0);

        if index >= (1u32 << TREE_DEPTH) {
            return Err(Error::TreeFull);
        }

        let zeros: Vec<BytesN<32>> = env.storage().persistent().get(&DataKey::TreeZeros).unwrap();

        let mut frontier: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::TreeFrontier)
            .unwrap_or_else(|| Vec::new(env));

        // Ensure frontier has TREE_DEPTH slots
        while frontier.len() < TREE_DEPTH {
            frontier.push_back(BytesN::from_array(env, &[0u8; 32]));
        }

        let mut current_hash = leaf;
        let mut current_index = index;

        for level in 0..TREE_DEPTH {
            if current_index & 1 == 0 {
                // Current node is a LEFT child: store in frontier, pair with zero
                frontier.set(level, current_hash.clone());
                current_hash = hash2(env, &current_hash, &zeros.get(level).unwrap());
            } else {
                // Current node is a RIGHT child: pair with frontier (left sibling)
                let left = frontier.get(level).unwrap();
                current_hash = hash2(env, &left, &current_hash);
            }
            current_index >>= 1;
        }

        // current_hash is now the new root
        let new_root = current_hash;

        env.storage()
            .instance()
            .set(&DataKey::TreeNextIndex, &(index + 1));
        env.storage()
            .persistent()
            .set(&DataKey::TreeFrontier, &frontier);
        env.storage().instance().set(&DataKey::TreeRoot, &new_root);

        // H4: append the new root to the historical-roots ring buffer, keeping
        // at most ROOT_HISTORY_SIZE entries (drop the oldest). In-flight
        // withdraw/transfer proofs bound to any of these roots stay valid.
        let mut history: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::RootHistory)
            .unwrap_or_else(|| Vec::new(env));
        history.push_back(new_root.clone());
        while history.len() > ROOT_HISTORY_SIZE {
            history.pop_front();
        }
        env.storage()
            .persistent()
            .set(&DataKey::RootHistory, &history);

        // Extend TTL for persistent data
        env.storage().persistent().extend_ttl(
            &DataKey::TreeFrontier,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::TreeZeros,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::RootHistory,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        log!(env, "Leaf inserted at index {}. New root computed.", index);

        Ok(new_root)
    }

    /// Internal function to check and mark a nullifier.
    ///
    /// H3: a spent nullifier must outlive the note it spends, or the note
    /// becomes re-spendable once its entry archives. We extend to the maximum
    /// practical persistent TTL on every write and re-extend on every touch.
    fn mark_nullifier(env: &Env, nullifier: BytesN<32>) -> Result<(), Error> {
        let key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::NullifierAlreadyUsed);
        }
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );
        Ok(())
    }

    /// H4: true if `root` is the current root or any root still inside the
    /// historical-roots window. Withdraw/transfer proofs bind a root; accepting
    /// any recent root keeps in-flight proofs valid across concurrent deposits.
    fn is_known_root(env: &Env, root: &BytesN<32>) -> bool {
        if let Some(current) = env
            .storage()
            .instance()
            .get::<DataKey, BytesN<32>>(&DataKey::TreeRoot)
        {
            if &current == root {
                return true;
            }
        }
        let history: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::RootHistory)
            .unwrap_or_else(|| Vec::new(env));
        history.iter().any(|r| &r == root)
    }

    /// Compute withdraw binding hash from recipient address
    /// Binds the proof to a specific withdrawal destination
    fn compute_withdraw_binding(env: &Env, recipient: &Address, amount: i128) -> BytesN<32> {
        use soroban_sdk::xdr::ToXdr;
        let mut bytes = soroban_sdk::Bytes::new(env);
        bytes.append(&recipient.to_xdr(env));

        let mut amt_bytes = [0u8; 16];
        amt_bytes[0..16].copy_from_slice(&amount.to_be_bytes());
        bytes.append(&soroban_sdk::Bytes::from_array(env, &amt_bytes));

        let sha_hash = env.crypto().sha256(&bytes);

        // Clear top 3 bits to fit in BN254 scalar field
        let mut hash_bytes = sha_hash.to_array();
        hash_bytes[0] &= 0x1F;

        BytesN::from_array(env, &hash_bytes)
    }

    /// Deposit one fixed 1-XLM note into a Vault V2 pool.
    pub fn deposit_v2(
        env: Env,
        depositor: Address,
        proof: Groth16Proof,
        commitment: BytesN<32>,
        asp_root: BytesN<32>,
    ) -> Result<(), Error> {
        let denomination = Self::v2_denomination(&env)?;
        depositor.require_auth();

        let commitment_key = DataKey::Commitment(commitment.clone());
        if env.storage().persistent().has(&commitment_key) {
            return Err(Error::CommitmentAlreadyExists);
        }

        let membership: Address = env
            .storage()
            .instance()
            .get(&DataKey::Membership)
            .ok_or(Error::NotInitialized)?;
        if !AspMembershipClient::new(&env, &membership).is_known_root(&asp_root) {
            return Err(Error::InvalidAspRoot);
        }

        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .ok_or(Error::NotInitialized)?;
        let public_inputs = Vec::from_array(&env, [commitment.clone(), asp_root]);
        if !Groth16VerifierClient::new(&env, &verifier).verify(
            &CircuitId::Deposit,
            &proof,
            &public_inputs,
        ) {
            return Err(Error::InvalidProof);
        }

        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(Error::NotInitialized)?;
        token::Client::new(&env, &asset).transfer(
            &depositor,
            &env.current_contract_address(),
            &denomination,
        );

        let leaf_index = env
            .storage()
            .instance()
            .get::<DataKey, u32>(&DataKey::TreeNextIndex)
            .unwrap_or(0);
        Self::insert_leaf(&env, commitment.clone())?;
        env.storage().persistent().set(&commitment_key, &true);
        env.storage().persistent().extend_ttl(
            &commitment_key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        Deposit {
            commitment,
            leaf_index,
            amount: denomination,
        }
        .publish(&env);
        Ok(())
    }

    /// V2 shielded transfer: 1-in / 1-out, fixed denomination.
    ///
    /// Spends one note and creates one note owned by the recipient. **No tokens
    /// move** — the value never leaves the pool, so the contract's balance is
    /// invariant across this call. That is what removes the need for the
    /// fee/relayer binding `withdraw_v2` carries: there is nothing to redirect
    /// and no payout to race for.
    ///
    /// Not authorized by `require_auth`. Possession of a proof bound to this
    /// exact `(nullifier, commitment, ephemeral point)` tuple is the
    /// authorization, which is what lets a relayer submit it and keeps the
    /// sender's Stellar address off the ledger entirely.
    pub fn transfer_v2(
        env: Env,
        proof: Groth16Proof,
        nullifier: BytesN<32>,
        commitment: BytesN<32>,
        ephemeral_x: BytesN<32>,
        ephemeral_y: BytesN<32>,
        root: BytesN<32>,
    ) -> Result<(), Error> {
        let denomination = Self::v2_denomination(&env)?;

        if !Self::is_known_root(&env, &root) {
            return Err(Error::UnknownRoot);
        }

        // Share `deposit_v2`'s commitment namespace so a transfer output can
        // never collide with a deposit. Without this, a repeated commitment
        // inserts a second leaf that shares the first one's nullifier — the
        // second note would be silently unspendable.
        let commitment_key = DataKey::Commitment(commitment.clone());
        if env.storage().persistent().has(&commitment_key) {
            return Err(Error::CommitmentAlreadyExists);
        }

        assert_nullifier_not_blocked(&env, &nullifier)?;
        Self::mark_nullifier(&env, nullifier.clone())?;

        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .ok_or(Error::NotInitialized)?;
        // Order must match `component main {public [...]}` in transfer_v2.circom.
        let public_inputs = Vec::from_array(
            &env,
            [
                root,
                nullifier.clone(),
                commitment.clone(),
                ephemeral_x.clone(),
                ephemeral_y.clone(),
            ],
        );
        if !Groth16VerifierClient::new(&env, &verifier).verify(
            &CircuitId::Transfer,
            &proof,
            &public_inputs,
        ) {
            return Err(Error::InvalidProof);
        }

        let leaf_index = env
            .storage()
            .instance()
            .get::<DataKey, u32>(&DataKey::TreeNextIndex)
            .unwrap_or(0);
        Self::insert_leaf(&env, commitment.clone())?;
        env.storage().persistent().set(&commitment_key, &true);
        env.storage().persistent().extend_ttl(
            &commitment_key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        TransferV2 {
            nullifier,
            commitment,
            leaf_index,
            ephemeral_x,
            ephemeral_y,
            amount: denomination,
        }
        .publish(&env);
        Ok(())
    }

    /// Withdraw one fixed 1-XLM note. No depositor authorization is required:
    /// possession of a valid recipient-bound proof authorizes a relayer to submit.
    pub fn withdraw_v2(
        env: Env,
        proof: Groth16Proof,
        nullifier: BytesN<32>,
        recipient: Address,
        root: BytesN<32>,
    ) -> Result<(), Error> {
        let denomination = Self::v2_denomination(&env)?;
        if !Self::is_known_root(&env, &root) {
            return Err(Error::UnknownRoot);
        }
        assert_nullifier_not_blocked(&env, &nullifier)?;
        Self::mark_nullifier(&env, nullifier.clone())?;

        let binding = Self::compute_withdraw_binding(&env, &recipient, denomination);
        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .ok_or(Error::NotInitialized)?;
        let public_inputs = Vec::from_array(&env, [root, nullifier.clone(), binding]);
        if !Groth16VerifierClient::new(&env, &verifier).verify(
            &CircuitId::Withdraw,
            &proof,
            &public_inputs,
        ) {
            return Err(Error::InvalidProof);
        }

        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(Error::NotInitialized)?;
        token::Client::new(&env, &asset).transfer(
            &env.current_contract_address(),
            &recipient,
            &denomination,
        );
        Withdraw {
            nullifier,
            recipient,
            amount: denomination,
        }
        .publish(&env);
        Ok(())
    }

    /// V2 rage-quit: the public, unconditional exit from the shielded pool.
    ///
    /// **Why this exists.** `withdraw_v2` and `transfer_v2` both call
    /// `assert_nullifier_not_blocked`, so once a note's nullifier is on the ASP
    /// blocklist that note can never be spent by either path. With no other
    /// route out, the pool would hold funds that *nobody* — not the owner, not
    /// the admin, not the ASP — could ever release. That is confiscation by
    /// omission, and it is a far worse failure than the one the blocklist is
    /// there to prevent.
    ///
    /// **Why it does not consult the blocklist.** Deliberate, and the whole
    /// point. The blocklist's job is to deny an *anonymous* exit, not to seize
    /// funds. Rage-quit reveals `commitment` publicly, which names the exact
    /// deposit being spent and links it to `recipient` on the ledger forever, so
    /// a blocked actor who uses it forfeits the privacy that made the pool worth
    /// abusing. The compliance property is preserved — arguably strengthened,
    /// since the exit is now traceable — while the confiscation risk is removed.
    /// Gating this on the blocklist would restore the trap and make the entire
    /// entrypoint pointless.
    ///
    /// **Why no Merkle proof.** There is nothing to hide, and the pool already
    /// records every accepted commitment under `DataKey::Commitment`. A direct
    /// key lookup proves inclusion more cheaply than re-verifying a path.
    ///
    /// Not `require_auth`'d: the proof is bound to `recipient` through
    /// `exit_binding`, so possession of the proof is the authorization and a
    /// relayer can submit it on behalf of someone with no funded account. The
    /// nullifier is the same one `withdraw_v2` would spend, so a note can still
    /// only ever be spent once, by whichever path it takes.
    pub fn ragequit_v2(
        env: Env,
        proof: Groth16Proof,
        commitment: BytesN<32>,
        nullifier: BytesN<32>,
        recipient: Address,
    ) -> Result<(), Error> {
        let denomination = Self::v2_denomination(&env)?;

        // Inclusion by lookup: this pool must actually hold the commitment.
        // Without it, a valid proof over a commitment from some *other* pool
        // would drain this one.
        let commitment_key = DataKey::Commitment(commitment.clone());
        if !env.storage().persistent().has(&commitment_key) {
            return Err(Error::UnknownCommitment);
        }
        env.storage().persistent().extend_ttl(
            &commitment_key,
            PERSISTENT_TTL_THRESHOLD,
            PERSISTENT_TTL_EXTEND,
        );

        // No blocklist check here — see the rationale above. Double-spend
        // protection is unchanged and still absolute.
        Self::mark_nullifier(&env, nullifier.clone())?;

        let binding = Self::compute_withdraw_binding(&env, &recipient, denomination);
        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .ok_or(Error::NotInitialized)?;
        let public_inputs =
            Vec::from_array(&env, [commitment.clone(), nullifier.clone(), binding]);
        if !Groth16VerifierClient::new(&env, &verifier).verify(
            &CircuitId::RageQuit,
            &proof,
            &public_inputs,
        ) {
            return Err(Error::InvalidProof);
        }

        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(Error::NotInitialized)?;
        token::Client::new(&env, &asset).transfer(
            &env.current_contract_address(),
            &recipient,
            &denomination,
        );

        RageQuit {
            nullifier,
            commitment,
            recipient,
            amount: denomination,
        }
        .publish(&env);
        Ok(())
    }

    /// D1: generic settlement primitive — the shared fund-movement entrypoint
    /// for position close, liquidation seizure, hidden orders, and agentic
    /// settlement. The **calling contract** (an allowlisted settlement authority)
    /// has already verified its own circuit-specific proof; this entrypoint
    /// performs the pool-level effects that only the custody contract can do:
    ///
    ///   1. spend `spent_nullifiers` in the pool's nullifier set (double-spend
    ///      protection for any pool notes consumed by the settlement),
    ///   2. insert `output_commitments` into the pool Merkle tree (re-shielded
    ///      notes / new positions become withdrawable via the normal circuits),
    ///   3. optionally pay `payout_amount` of the pool asset to `payout_recipient`
    ///      (funds leaving the shield — e.g. seized collateral to a keeper).
    ///
    /// Trust model: the pool trusts an allowlisted authority to have verified the
    /// settlement (amounts, nullifiers, commitments) against its circuit. The
    /// allowlist is the security boundary — only admin-approved contracts can move
    /// funds this way. A contract auto-authorizes the sub-calls it makes, so an
    /// authority's own invocation passes `require_auth` while any other caller is
    /// rejected (same pattern as the liquidation-engine H5 heartbeat gate).
    pub fn execute_settlement(
        env: Env,
        authority: Address,
        spent_nullifiers: Vec<BytesN<32>>,
        output_commitments: Vec<BytesN<32>>,
        payout_recipient: Option<Address>,
        payout_amount: i128,
    ) -> Result<(), Error> {
        Self::assert_v1(&env)?;
        // The authority contract authorizes its own sub-call into the pool.
        authority.require_auth();

        // Only admin-approved settlement contracts may move funds this way.
        if !env
            .storage()
            .instance()
            .has(&DataKey::SettlementAuthority(authority.clone()))
        {
            return Err(Error::NotSettlementAuthority);
        }

        // A negative payout is nonsensical (and would mis-encode); reject up front.
        if payout_amount < 0 {
            return Err(Error::InvalidAmount);
        }

        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(Error::NotInitialized)?;

        // 1. Spend nullifiers (rejects reuse — double-close / double-seize guard).
        for nf in spent_nullifiers.iter() {
            Self::mark_nullifier(&env, nf)?;
        }

        // 2. Insert output commitments into the pool tree (withdrawable notes).
        let num_commitments = output_commitments.len();
        for c in output_commitments.iter() {
            Self::insert_leaf(&env, c)?;
        }

        // 3. Optional public payout (funds leaving the shield). Only pays when a
        //    recipient is given AND the amount is positive; the SAC transfer itself
        //    fails if the pool lacks the balance (natural solvency guard).
        if payout_amount > 0 {
            if let Some(recipient) = payout_recipient {
                let token_client = token::Client::new(&env, &asset);
                token_client.transfer(&env.current_contract_address(), &recipient, &payout_amount);
            }
        }

        Settlement {
            authority,
            num_commitments,
            payout_amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Admin: turn ASP blocklist enforcement on or off.
    ///
    /// Exists so that "not enforcing" is a state someone chose and anyone can
    /// read, rather than something inferred at call time from whether a probe
    /// happened to succeed. Disabling is legitimate — a pool with no blocklist
    /// wired yet — but it should be visible on the ledger and in
    /// `blocklist_enabled()`, not implied by an address comparison.
    pub fn set_blocklist_enabled(env: Env, enabled: bool) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::BlocklistEnabled, &enabled);
        Ok(())
    }

    /// Whether spends currently consult the ASP blocklist. Absent state reads as
    /// enabled, matching `assert_nullifier_not_blocked`.
    pub fn blocklist_enabled(env: Env) -> bool {
        blocklist_is_enabled(&env)
    }

    /// Admin: add a contract to the settlement-authority allowlist.
    pub fn add_settlement_authority(env: Env, authority: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::SettlementAuthority(authority), &true);
        Ok(())
    }

    /// Admin: remove a contract from the settlement-authority allowlist.
    pub fn remove_settlement_authority(env: Env, authority: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage()
            .instance()
            .remove(&DataKey::SettlementAuthority(authority));
        Ok(())
    }

    /// True if `authority` is on the settlement-authority allowlist.
    pub fn is_settlement_authority(env: Env, authority: Address) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::SettlementAuthority(authority))
    }

    /// Pull public tokens from `depositor` into pool custody. Callable only by
    /// settlement authorities (hidden-order / agentic hubs lock escrow at commit).
    /// Both the authority sub-call and the depositor must authorize.
    pub fn pull_public_deposit(
        env: Env,
        authority: Address,
        depositor: Address,
        amount: i128,
    ) -> Result<(), Error> {
        Self::assert_v1(&env)?;
        authority.require_auth();
        if !env
            .storage()
            .instance()
            .has(&DataKey::SettlementAuthority(authority.clone()))
        {
            return Err(Error::NotSettlementAuthority);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        depositor.require_auth();

        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(Error::NotInitialized)?;
        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&depositor, &env.current_contract_address(), &amount);
        Ok(())
    }

    /// Get the current Merkle root
    pub fn get_root(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::TreeRoot)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]))
    }

    /// Get the current leaf count
    pub fn get_leaf_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TreeNextIndex)
            .unwrap_or(0)
    }

    pub fn get_denomination(env: Env) -> Result<i128, Error> {
        Self::v2_denomination(&env)
    }

    /// Get the admin authorized to upgrade this pool.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// Upgrade the pool's WASM code in place (admin-gated).
    ///
    /// This is the single most important mainnet safety valve: it lets a bug fix
    /// or feature addition (deposit ASP membership is now enforced; still to come:
    /// non-membership on transfer/withdraw, `execute_settlement`) reuse the SAME
    /// pool address, so the Merkle tree, nullifier set, and root history all
    /// survive and every user note stays valid. Without it, a fix means a new
    /// address with empty state and stranded funds.
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
}

#[cfg(test)]
mod test;
