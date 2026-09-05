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

-- Positions.
--
-- Soroban RPC retains events for about seven days and a position can be open
-- far longer, so this is the only durable record that a position id belongs to
-- an address. It is a LISTING index, not a source of truth: the client re-reads
-- every position from the contract before acting on it, because a stale row
-- here would produce a close proof describing a different position.
--
-- `tier_id` and `entry_price` are stored because they are what makes a closed
-- position's payout note recoverable on a clean device -- see
-- frontend/src/dapp/lib/position-notes.ts.
CREATE TABLE IF NOT EXISTS positions (
    id SERIAL PRIMARY KEY,
    position_id VARCHAR(64) NOT NULL UNIQUE,
    owner VARCHAR(56) NOT NULL,
    commitment VARCHAR(64) NOT NULL,
    change_commitment VARCHAR(64),
    tier_id INTEGER,
    direction INTEGER,
    size NUMERIC(38,0),
    margin NUMERIC(38,0),
    entry_price NUMERIC(38,0),
    last_health_timestamp BIGINT,
    is_closed BOOLEAN DEFAULT FALSE,
    -- Set on close. Both are public in the PositionClose event, and together
    -- with tier_id they determine the payout note exactly.
    close_price NUMERIC(38,0),
    payout NUMERIC(38,0),
    fee NUMERIC(38,0),
    output_note_commitment VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Owner lookup is the only query the API makes, and it runs on every page load.
CREATE INDEX IF NOT EXISTS positions_owner_idx ON positions (owner);

-- Added after the table shipped, so existing deployments need them too.
-- Postgres has no IF NOT EXISTS for a column list, hence one statement each.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS change_commitment VARCHAR(64);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS tier_id INTEGER;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS margin NUMERIC(38,0);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_price NUMERIC(38,0);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS close_price NUMERIC(38,0);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS payout NUMERIC(38,0);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS fee NUMERIC(38,0);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS output_note_commitment VARCHAR(64);
