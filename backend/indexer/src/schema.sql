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
    last_health_timestamp BIGINT,
    is_closed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
