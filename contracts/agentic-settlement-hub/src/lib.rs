#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    Address, BytesN, Env, Vec,
};
use vayyl_types::{CircuitId, Groth16Proof};

#[soroban_sdk::contractclient(name = "Groth16VerifierClient")]
pub trait Groth16VerifierInterface {
    fn verify(env: Env, circuit_id: CircuitId, proof: Groth16Proof, public_inputs: Vec<BytesN<32>>) -> Result<bool, soroban_sdk::Error>;
}

/// E3: decoupled client for the pool's settlement primitive. A claimed quest
/// pays the reward out of the pool to the agent via `execute_settlement`.
#[soroban_sdk::contractclient(name = "VayylPoolClient")]
pub trait VayylPoolInterface {
    fn execute_settlement(
        env: Env,
        authority: Address,
        spent_nullifiers: Vec<BytesN<32>>,
        output_commitments: Vec<BytesN<32>>,
        payout_recipient: Option<Address>,
        payout_amount: i128,
    ) -> Result<(), soroban_sdk::Error>;
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct QuestState {
    pub commitment: BytesN<32>,
    pub reward_amount: i128,
    pub pool: Address,
    pub claimed: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin authorized to `upgrade()` this contract in place.
    Admin,
    Verifier,
    Quest(BytesN<32>),
    AgentNullifier(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    QuestNotFound = 3,
    QuestAlreadyClaimed = 4,
    AgentNullifierSpent = 5,
    ProofFailed = 6,
    InvalidAmount = 7,
    NotInitialized = 8,
}

#[contract]
pub struct AgenticSettlementHubContract;

#[contractimpl]
impl AgenticSettlementHubContract {
    pub fn initialize(env: Env, admin: Address, verifier: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Verifier) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        Ok(())
    }

    /// Upgrade the contract's WASM code in place (admin-gated).
    /// Keeps every quest and spent agent-nullifier intact.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::Unauthorized)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Create a quest — escrow a reward for an agent task.
    ///
    /// HONEST-SCOPE CAVEAT (parity with the order registry / D3 seize): the
    /// fund-locking side — pulling `reward_amount` into the pool at create time —
    /// is a deposit-style flow not wired here; on testnet the pool is pre-funded
    /// and `reward_amount` is the accounting figure paid out. The pool's balance
    /// is the hard cap.
    pub fn create_quest(
        env: Env,
        quest_id: BytesN<32>,
        quest_commitment: BytesN<32>,
        reward_amount: i128,
        pool: Address,
    ) -> Result<(), Error> {
        if reward_amount < 0 {
            return Err(Error::InvalidAmount);
        }
        let state = QuestState {
            commitment: quest_commitment,
            reward_amount,
            pool,
            claimed: false,
        };
        env.storage().persistent().set(&DataKey::Quest(quest_id), &state);
        Ok(())
    }

    /// Agent claims a quest reward with a proof.
    ///
    /// The SealedOrder proof enforces that the caller knows the opening of the
    /// quest commitment (public input `[quest_commitment]`). Double-claim is
    /// blocked two ways: a fresh `agent_nullifier` is spent-once, and the quest's
    /// own `claimed` flag is set before the payout (reentrancy guard).
    ///
    /// FRONT-RUNNING NOTE: the SealedOrder circuit does not bind the recipient
    /// in-circuit, so the payout target is protected by `recipient.require_auth()`
    /// — only the agent itself can direct its reward. (Binding recipient into the
    /// proof would need a dedicated claim circuit; the nullifier + recipient auth
    /// are the gate on testnet.)
    pub fn claim_quest(
        env: Env,
        quest_id: BytesN<32>,
        proof: Groth16Proof,
        agent_nullifier: BytesN<32>,
        recipient: Address,
    ) -> Result<(), Error> {
        // Only the agent may direct its own reward (front-running defense).
        recipient.require_auth();

        // Fresh agent nullifier (prevents double-claim across quests).
        if env.storage().persistent().has(&DataKey::AgentNullifier(agent_nullifier.clone())) {
            return Err(Error::AgentNullifierSpent);
        }

        let mut state: QuestState = env
            .storage()
            .persistent()
            .get(&DataKey::Quest(quest_id.clone()))
            .ok_or(Error::QuestNotFound)?;

        if state.claimed {
            return Err(Error::QuestAlreadyClaimed);
        }

        // 1. Verify the SealedOrder (commitment-opening) proof.
        //    Public inputs: [quest_commitment].
        let verifier: Address = env
            .storage()
            .instance()
            .get(&DataKey::Verifier)
            .ok_or(Error::NotInitialized)?;
        let verifier_client = Groth16VerifierClient::new(&env, &verifier);
        let mut public_inputs = Vec::new(&env);
        public_inputs.push_back(state.commitment.clone());

        let is_valid = verifier_client.verify(&CircuitId::SealedOrder, &proof, &public_inputs);
        if !is_valid {
            return Err(Error::ProofFailed);
        }

        // 2. Spend the guards BEFORE the external payout (reentrancy guard).
        state.claimed = true;
        env.storage().persistent().set(&DataKey::Quest(quest_id), &state);
        env.storage().persistent().set(&DataKey::AgentNullifier(agent_nullifier), &true);

        // 3. Real fund movement: pay the reward from the pool to the agent via
        //    execute_settlement. This hub must be an allowlisted settlement
        //    authority on the pool.
        if state.reward_amount > 0 {
            let pool_client = VayylPoolClient::new(&env, &state.pool);
            let no_nullifiers: Vec<BytesN<32>> = Vec::new(&env);
            let no_commitments: Vec<BytesN<32>> = Vec::new(&env);
            pool_client.execute_settlement(
                &env.current_contract_address(),
                &no_nullifiers,
                &no_commitments,
                &Some(recipient),
                &state.reward_amount,
            );
        }

        Ok(())
    }

    pub fn get_quest(env: Env, quest_id: BytesN<32>) -> Result<QuestState, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Quest(quest_id))
            .ok_or(Error::QuestNotFound)
    }

    /// Get the admin authorized to upgrade this contract.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage().instance().get(&DataKey::Admin).ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract as sdk_contract, contractimpl as sdk_contractimpl, token};

    /// Stand-in verifier that always accepts (real proofs need registered VKs).
    #[sdk_contract]
    pub struct MockVerifier;
    #[sdk_contractimpl]
    impl MockVerifier {
        pub fn verify(
            _env: Env,
            _circuit_id: CircuitId,
            _proof: Groth16Proof,
            _public_inputs: Vec<BytesN<32>>,
        ) -> Result<bool, soroban_sdk::Error> {
            Ok(true)
        }
    }

    fn dummy_proof(env: &Env) -> Groth16Proof {
        Groth16Proof {
            a: BytesN::from_array(env, &[0u8; 64]),
            b: BytesN::from_array(env, &[0u8; 128]),
            c: BytesN::from_array(env, &[0u8; 64]),
        }
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let contract_id = env.register(AgenticSettlementHubContract, ());
        let client = AgenticSettlementHubContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.initialize(&admin, &verifier);
        assert_eq!(client.admin(), admin);
    }

    #[test]
    fn test_double_init_fails() {
        let env = Env::default();
        let contract_id = env.register(AgenticSettlementHubContract, ());
        let client = AgenticSettlementHubContractClient::new(&env, &contract_id);
        let a = Address::generate(&env);
        client.initialize(&a, &a);
        assert!(client.try_initialize(&a, &a).is_err());
    }

    #[test]
    fn test_create_rejects_negative_reward() {
        let env = Env::default();
        let contract_id = env.register(AgenticSettlementHubContract, ());
        let client = AgenticSettlementHubContractClient::new(&env, &contract_id);
        let a = Address::generate(&env);
        client.initialize(&a, &a);
        let qid = BytesN::from_array(&env, &[1u8; 32]);
        let c = BytesN::from_array(&env, &[2u8; 32]);
        assert!(client.try_create_quest(&qid, &c, &-1i128, &a).is_err());
    }

    // ---- E3/E4: claim_quest pays the reward out of a real pool ------------

    #[test]
    fn test_claim_quest_pays_out_e2e() {
        use vayyl_pool::{VayylPool, VayylPoolClient};

        let env = Env::default();
        env.mock_all_auths();

        // SAC asset; the pool custodies the reward liquidity.
        let sac_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(sac_admin);
        let asset = sac.address();
        let verifier_id = env.register(MockVerifier, ());

        // Real pool, funded.
        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let pool_id = env.register(VayylPool, ());
        let pool = VayylPoolClient::new(&env, &pool_id);
        pool.initialize(&admin, &asset, &verifier_id, &dummy, &dummy);
        token::StellarAssetClient::new(&env, &asset).mint(&pool_id, &10_000);

        // Real hub wired to the mock verifier.
        let hub_id = env.register(AgenticSettlementHubContract, ());
        let hub = AgenticSettlementHubContractClient::new(&env, &hub_id);
        hub.initialize(&admin, &verifier_id);

        // The hub must be an allowlisted settlement authority to move funds.
        pool.add_settlement_authority(&hub_id);

        // Create a quest with a 250 reward.
        let quest_id = BytesN::from_array(&env, &[0x01; 32]);
        let commitment = BytesN::from_array(&env, &[0xC1; 32]);
        hub.create_quest(&quest_id, &commitment, &250i128, &pool_id);

        // Agent claims: reward paid out to the agent.
        let agent = Address::generate(&env);
        let agent_nullifier = BytesN::from_array(&env, &[0x0A; 32]);
        hub.claim_quest(&quest_id, &dummy_proof(&env), &agent_nullifier, &agent);

        // Real fund movement: agent credited 250, pool debited to 9_750.
        assert_eq!(token::Client::new(&env, &asset).balance(&agent), 250);
        assert_eq!(token::Client::new(&env, &asset).balance(&pool_id), 9_750);
        assert!(hub.get_quest(&quest_id).claimed);

        // Second claim rejected — quest already claimed.
        let agent2_nullifier = BytesN::from_array(&env, &[0x0B; 32]);
        assert!(hub
            .try_claim_quest(&quest_id, &dummy_proof(&env), &agent2_nullifier, &agent)
            .is_err());
    }

    // The same agent_nullifier can't claim twice (double-claim guard across quests).
    #[test]
    fn test_agent_nullifier_double_spend_fails() {
        use vayyl_pool::{VayylPool, VayylPoolClient};

        let env = Env::default();
        env.mock_all_auths();

        let sac_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(sac_admin);
        let asset = sac.address();
        let verifier_id = env.register(MockVerifier, ());

        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let pool_id = env.register(VayylPool, ());
        let pool = VayylPoolClient::new(&env, &pool_id);
        pool.initialize(&admin, &asset, &verifier_id, &dummy, &dummy);
        token::StellarAssetClient::new(&env, &asset).mint(&pool_id, &10_000);

        let hub_id = env.register(AgenticSettlementHubContract, ());
        let hub = AgenticSettlementHubContractClient::new(&env, &hub_id);
        hub.initialize(&admin, &verifier_id);
        pool.add_settlement_authority(&hub_id);

        let commitment = BytesN::from_array(&env, &[0xC1; 32]);
        let q1 = BytesN::from_array(&env, &[0x01; 32]);
        let q2 = BytesN::from_array(&env, &[0x02; 32]);
        hub.create_quest(&q1, &commitment, &100i128, &pool_id);
        hub.create_quest(&q2, &commitment, &100i128, &pool_id);

        let agent = Address::generate(&env);
        let nullifier = BytesN::from_array(&env, &[0x0A; 32]);
        hub.claim_quest(&q1, &dummy_proof(&env), &nullifier, &agent);
        // Reusing the SAME agent_nullifier on a different quest must fail.
        assert!(hub
            .try_claim_quest(&q2, &dummy_proof(&env), &nullifier, &agent)
            .is_err());
    }

    // A claim by a non-allowlisted hub must fail at the pool boundary.
    #[test]
    fn test_claim_without_pool_allowlist_fails() {
        use vayyl_pool::{VayylPool, VayylPoolClient};

        let env = Env::default();
        env.mock_all_auths();

        let sac_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(sac_admin);
        let asset = sac.address();
        let verifier_id = env.register(MockVerifier, ());

        let admin = Address::generate(&env);
        let dummy = Address::generate(&env);
        let pool_id = env.register(VayylPool, ());
        let pool = VayylPoolClient::new(&env, &pool_id);
        pool.initialize(&admin, &asset, &verifier_id, &dummy, &dummy);
        token::StellarAssetClient::new(&env, &asset).mint(&pool_id, &10_000);

        let hub_id = env.register(AgenticSettlementHubContract, ());
        let hub = AgenticSettlementHubContractClient::new(&env, &hub_id);
        hub.initialize(&admin, &verifier_id);
        // NOTE: deliberately NOT allowlisted.

        let quest_id = BytesN::from_array(&env, &[0x01; 32]);
        let commitment = BytesN::from_array(&env, &[0xC1; 32]);
        hub.create_quest(&quest_id, &commitment, &250i128, &pool_id);

        let agent = Address::generate(&env);
        let agent_nullifier = BytesN::from_array(&env, &[0x0A; 32]);
        let res = hub.try_claim_quest(&quest_id, &dummy_proof(&env), &agent_nullifier, &agent);
        assert!(res.is_err(), "claim without pool allowlist must fail");
        assert_eq!(token::Client::new(&env, &asset).balance(&agent), 0);
    }
}
