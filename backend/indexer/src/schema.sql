CREATE TABLE IF NOT EXISTS commitments (
    id SERIAL PRIMARY KEY,
    pool_address VARCHAR(56) NOT NULL,
    commitment_hash VARCHAR(64) NOT NULL,
    leaf_index INTEGER NOT NULL,
    tx_hash VARCHAR(64) NOT NULL,
    ledger_sequence INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (pool_address, commitment_hash)
);

-- Shielded-transfer outputs. `source` distinguishes them from deposits so the
-- client can label activity correctly; the ephemeral point is the sender's
-- one-time BabyJubjub R, which is what lets a recipient discover the note.
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'deposit';
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS ephemeral_x VARCHAR(64);
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS ephemeral_y VARCHAR(64);

-- V3 outputs carry their amount encrypted to the owner under a one-time pad
-- derived from the same ECDH secret as the blindness. This is NOT optional
-- metadata: with arbitrary amounts an owner cannot recompute
-- `commitment = Poseidon2(amount, pubX, pubY, blindness)` without the amount,
-- so a row missing this is a note nobody can ever find or spend. Null for V2
-- rows, whose amount was a fixed constant everybody already knew.
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS amount_cipher VARCHAR(64);

-- Deposit amounts are PUBLIC on-chain (the token transfer is visible either
-- way), and a wallet restoring on a clean device needs them: it re-derives each
-- deposit's blindness from its spend key, but cannot rebuild the commitment
-- without also knowing the amount. Null for transfer outputs, whose amounts are
-- private and travel encrypted in amount_cipher instead.
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(39, 0);

-- Repair, then make the bug unrepresentable. Rows with leaf_index = -1 (written
-- by an older build for V1 transfer events, which carry no index) sort ahead of
-- every deposit under `ORDER BY leaf_index ASC`, shifting every leaf index and
-- breaking Merkle-path reconstruction for all users. Delete them, then let the
-- unique index reject any future attempt to store two commitments at one leaf.
DELETE FROM commitments WHERE leaf_index < 0;
CREATE UNIQUE INDEX IF NOT EXISTS commitments_pool_leaf_idx
    ON commitments (pool_address, leaf_index);

CREATE TABLE IF NOT EXISTS nullifiers (
    id SERIAL PRIMARY KEY,
    pool_address VARCHAR(56) NOT NULL,
    nullifier_hash VARCHAR(64) NOT NULL,
    tx_hash VARCHAR(64) NOT NULL,
    ledger_sequence INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (pool_address, nullifier_hash)
);

CREATE TABLE IF NOT EXISTS indexer_state (
    key VARCHAR(64) PRIMARY KEY,
    value VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
    id SERIAL PRIMARY KEY,
    position_id VARCHAR(64) NOT NULL UNIQUE,
    owner VARCHAR(56) NOT NULL,
    commitment VARCHAR(64) NOT NULL,
    direction INTEGER,
    size NUMERIC(38,0),
    last_health_timestamp BIGINT,
    is_closed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
