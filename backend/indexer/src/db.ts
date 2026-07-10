import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

export class Database {
    private pool: pg.Pool;

    constructor(connectionString: string) {
        // Managed Postgres (Neon, Supabase, etc.) requires TLS. Depending on the
        // `pg` version, `?sslmode=require` in the URL isn't always honored, so
        // enable SSL explicitly when the target looks like a managed/SSL endpoint.
        // rejectUnauthorized:false avoids CA-chain friction; fine for a testnet indexer.
        const needsSsl =
            /sslmode=require/i.test(connectionString) ||
            /neon\.tech|supabase\.|render\.com|amazonaws\.com/i.test(connectionString);
        this.pool = new Pool({
            connectionString,
            ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
        });
    }

    async init() {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        await this.pool.query(schema);
        console.log('Database initialized with schema');
    }

    async getLastLedger(): Promise<number> {
        const result = await this.pool.query(
            'SELECT value FROM indexer_state WHERE key = $1',
            ['last_ledger']
        );
        if (result.rows.length > 0) {
            return parseInt(result.rows[0].value, 10);
        }
        return 0; // Or genesis ledger if known
    }

    async setLastLedger(ledger: number) {
        await this.pool.query(
            `INSERT INTO indexer_state (key, value) VALUES ('last_ledger', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [ledger.toString()]
        );
    }

    async insertCommitment(
        poolAddress: string,
        commitmentHash: string,
        leafIndex: number,
        txHash: string,
        ledgerSeq: number
    ) {
        await this.pool.query(
            `INSERT INTO commitments (pool_address, commitment_hash, leaf_index, tx_hash, ledger_sequence)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [poolAddress, commitmentHash, leafIndex, txHash, ledgerSeq]
        );
    }

    async insertNullifier(
        poolAddress: string,
        nullifierHash: string,
        txHash: string,
        ledgerSeq: number
    ) {
        await this.pool.query(
            `INSERT INTO nullifiers (pool_address, nullifier_hash, tx_hash, ledger_sequence)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [poolAddress, nullifierHash, txHash, ledgerSeq]
        );
    }

    async getCommitments(poolAddress: string): Promise<string[]> {
        const result = await this.pool.query(
            'SELECT commitment_hash FROM commitments WHERE pool_address = $1 ORDER BY leaf_index ASC',
            [poolAddress]
        );
        return result.rows.map(r => r.commitment_hash);
    }

    async getNullifiers(poolAddress: string): Promise<string[]> {
        const result = await this.pool.query(
            'SELECT nullifier_hash FROM nullifiers WHERE pool_address = $1',
            [poolAddress]
        );
        return result.rows.map(r => r.nullifier_hash);
    }

    async insertPosition(positionId: string, owner: string, commitment: string, direction: number, size: bigint) {
        await this.pool.query(
            `INSERT INTO positions (position_id, owner, commitment, direction, size)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (position_id) DO UPDATE SET commitment = EXCLUDED.commitment, direction = EXCLUDED.direction, size = EXCLUDED.size, is_closed = FALSE`,
            [positionId, owner, commitment, direction, size.toString()]
        );
    }

    async updatePositionHealth(positionId: string, timestamp: number) {
        await this.pool.query(
            `UPDATE positions SET last_health_timestamp = $2, updated_at = CURRENT_TIMESTAMP WHERE position_id = $1`,
            [positionId, timestamp]
        );
    }

    async updatePositionClose(positionId: string, newCommitment: string) {
        await this.pool.query(
            `UPDATE positions SET commitment = $2, updated_at = CURRENT_TIMESTAMP WHERE position_id = $1`,
            [positionId, newCommitment]
        );
    }

    async getPositions(owner?: string): Promise<any[]> {
        let query = 'SELECT * FROM positions';
        let params: any[] = [];
        if (owner) {
            query += ' WHERE owner = $1';
            params.push(owner);
        }
        query += ' ORDER BY created_at DESC';
        const result = await this.pool.query(query, params);
        return result.rows;
    }
}
