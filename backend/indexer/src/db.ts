import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const { Pool } = pg;

function cursorKey(poolAddress: string): string {
    const namespace = process.env.INDEXER_CURSOR_NAMESPACE ?? '';
    const scopedAddress = namespace ? `${namespace}:${poolAddress}` : poolAddress;
    return createHash('sha256').update(scopedAddress).digest('hex');
}

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

    async getLastLedger(poolAddress: string): Promise<number> {
        const result = await this.pool.query(
            'SELECT value FROM indexer_state WHERE key = $1',
            [cursorKey(poolAddress)]
        );
        if (result.rows.length > 0) {
            return parseInt(result.rows[0].value, 10);
        }
        return 0; // Or genesis ledger if known
    }

    async setLastLedger(poolAddress: string, ledger: number) {
        await this.pool.query(
            `INSERT INTO indexer_state (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [cursorKey(poolAddress), ledger.toString()]
        );
    }

    async insertCommitment(
        poolAddress: string,
        commitmentHash: string,
        leafIndex: number,
        txHash: string,
        ledgerSeq: number,
        transfer?: {
            source: 'transfer';
            ephemeralX: string;
            ephemeralY: string;
            /** V3 only: the output's amount under a one-time pad. */
            amountCipher?: string;
        },
        /** Deposits only: the public amount, needed for clean-device recovery. */
        depositAmount?: bigint,
    ) {
        // A commitment with no real leaf index cannot be ordered, and an
        // unordered commitment corrupts every client's Merkle path. Refuse it
        // here rather than letting a caller persist a sentinel.
        if (!Number.isInteger(leafIndex) || leafIndex < 0) {
            throw new Error(
                `Refusing to index commitment ${commitmentHash} with leaf_index ${leafIndex}: ` +
                `leaf indices must be non-negative integers.`
            );
        }
        await this.pool.query(
            `INSERT INTO commitments
                 (pool_address, commitment_hash, leaf_index, tx_hash, ledger_sequence,
                  source, ephemeral_x, ephemeral_y, amount_cipher, deposit_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT DO NOTHING`,
            [
                poolAddress, commitmentHash, leafIndex, txHash, ledgerSeq,
                transfer?.source ?? 'deposit',
                transfer?.ephemeralX ?? null,
                transfer?.ephemeralY ?? null,
                transfer?.amountCipher ?? null,
                depositAmount !== undefined ? depositAmount.toString() : null,
            ]
        );
    }

    /**
     * Shielded-transfer outputs, oldest first — the recipient's scan feed. Each
     * row carries the sender's ephemeral point R; a wallet derives the note's
     * blindness as Poseidon2((spendKey·R).x, 0) and keeps the rows whose
     * commitment it can reproduce.
     */
    async getTransfers(poolAddress: string, sinceLedger = 0): Promise<Array<{
        commitment: string; leafIndex: number; ephemeralX: string; ephemeralY: string;
        amountCipher: string | null; txHash: string; ledgerSequence: number;
    }>> {
        const result = await this.pool.query(
            `SELECT commitment_hash, leaf_index, ephemeral_x, ephemeral_y, amount_cipher,
                    tx_hash, ledger_sequence
             FROM commitments
             WHERE pool_address = $1 AND source = 'transfer' AND ledger_sequence >= $2
             ORDER BY leaf_index ASC`,
            [poolAddress, sinceLedger]
        );
        return result.rows.map(r => ({
            commitment: r.commitment_hash,
            leafIndex: r.leaf_index,
            ephemeralX: r.ephemeral_x,
            ephemeralY: r.ephemeral_y,
            // Null on V2 rows, whose amount was a known constant. A V3 row
            // without it is unusable: the owner cannot rebuild the commitment.
            amountCipher: r.amount_cipher,
            txHash: r.tx_hash,
            ledgerSequence: r.ledger_sequence,
        }));
    }

    /**
     * The leaf set must be gap-free: clients rebuild the Merkle tree from
     * `getCommitments()` in order, so a missing index silently produces a wrong
     * root, which surfaces only as an opaque UnknownRoot at submit time.
     */
    async assertDense(poolAddress: string): Promise<{ dense: boolean; count: number; maxIndex: number }> {
        const result = await this.pool.query(
            'SELECT COUNT(*)::int AS c, COALESCE(MAX(leaf_index), -1)::int AS m FROM commitments WHERE pool_address = $1',
            [poolAddress]
        );
        const { c, m } = result.rows[0];
        const dense = m + 1 === c;
        if (!dense) {
            console.error(
                `Commitment set for ${poolAddress} is NOT dense: ${c} rows but max leaf_index ${m}. ` +
                `Merkle roots rebuilt from this data will be wrong.`
            );
        }
        return { dense, count: c, maxIndex: m };
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

    /**
     * Deposits with their public amounts, oldest first. A wallet restoring on a
     * clean device re-derives each deposit's blindness from its spend key, but
     * cannot rebuild the commitment without the amount, so this feed is what
     * makes an unspent deposit recoverable at all.
     */
    async getDeposits(poolAddress: string): Promise<Array<{
        commitment: string; leafIndex: number; amountStroops: string; txHash: string;
    }>> {
        const result = await this.pool.query(
            `SELECT commitment_hash, leaf_index, deposit_amount, tx_hash
             FROM commitments
             WHERE pool_address = $1 AND source = 'deposit' AND deposit_amount IS NOT NULL
             ORDER BY leaf_index ASC`,
            [poolAddress]
        );
        return result.rows.map(r => ({
            commitment: r.commitment_hash,
            leafIndex: r.leaf_index,
            amountStroops: String(r.deposit_amount),
            txHash: r.tx_hash,
        }));
    }

    async getCommitments(poolAddress: string): Promise<string[]> {
        const result = await this.pool.query(
            'SELECT commitment_hash FROM commitments WHERE pool_address = $1 ORDER BY leaf_index ASC',
            [poolAddress]
        );
        return result.rows.map(r => r.commitment_hash);
    }

    /**
     * Every leaf with the provenance needed to re-derive it from public data.
     *
     * `getCommitments` returns bare hashes, which is all a client needs to build
     * a Merkle path but not enough for anyone to CHECK that list. Soroban RPC
     * retains events for only ~7 days, so once a pool's deposits age out this
     * database is the only copy of the leaf ordering in existence — and an
     * unverifiable sole copy is not a record, it is a liability.
     *
     * `tx_hash` is what fixes that. Horizon keeps transaction envelopes forever,
     * and the commitment is a call ARGUMENT to deposit_v2/transfer_v2, not just
     * an event field, so each leaf here can be re-proved against permanent
     * public history long after the event stream is gone. See
     * `circuits/scripts/verify_tree_snapshot.mjs`.
     */
    async getTreeSnapshot(poolAddress: string): Promise<Array<{
        index: number; commitment: string; source: string;
        txHash: string; ledger: number;
        ephemeralX: string | null; ephemeralY: string | null;
        amountCipher: string | null;
    }>> {
        const result = await this.pool.query(
            `SELECT commitment_hash, leaf_index, source, tx_hash, ledger_sequence,
                    ephemeral_x, ephemeral_y, amount_cipher
             FROM commitments
             WHERE pool_address = $1
             ORDER BY leaf_index ASC`,
            [poolAddress]
        );
        return result.rows.map(r => ({
            index: r.leaf_index,
            commitment: r.commitment_hash,
            source: r.source,
            txHash: r.tx_hash,
            ledger: r.ledger_sequence,
            ephemeralX: r.ephemeral_x,
            ephemeralY: r.ephemeral_y,
            // Carried into the snapshot so an offline wallet can still recover a
            // V3 note's value. Without it the snapshot would let a user rebuild
            // the tree but not identify which leaves are theirs.
            amountCipher: r.amount_cipher,
        }));
    }

    async getNullifiers(poolAddress: string): Promise<string[]> {
        const result = await this.pool.query(
            'SELECT nullifier_hash FROM nullifiers WHERE pool_address = $1',
            [poolAddress]
        );
        return result.rows.map(r => r.nullifier_hash);
    }

    /**
     * Record an opened position.
     *
     * DO NOTHING on conflict, not UPDATE. The contract refuses a duplicate
     * position id (audit H6), so a second `position_open` for the same id can
     * only be a replayed event -- and treating it as an update would let a
     * replay rewrite an existing row's owner and tier. The previous version
     * reset `is_closed` to FALSE as part of that update, which would also
     * resurrect a closed position in the listing.
     */
    async insertPosition(p: {
        positionId: string;
        owner: string;
        commitment: string;
        changeCommitment: string;
        tierId: number;
        direction: number;
        size: bigint;
        margin: bigint;
        entryPrice: bigint;
    }) {
        await this.pool.query(
            `INSERT INTO positions
               (position_id, owner, commitment, change_commitment, tier_id,
                direction, size, margin, entry_price, is_closed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)
             ON CONFLICT (position_id) DO NOTHING`,
            [
                p.positionId, p.owner, p.commitment, p.changeCommitment, p.tierId,
                p.direction, p.size.toString(), p.margin.toString(), p.entryPrice.toString(),
            ]
        );
    }

    async updatePositionHealth(positionId: string, timestamp: number) {
        // Monotonic: an out-of-order event must not move the heartbeat
        // BACKWARDS, which would make a healthy position look overdue for
        // liquidation to anything reading this table.
        await this.pool.query(
            `UPDATE positions
                SET last_health_timestamp = GREATEST(COALESCE(last_health_timestamp, 0), $2),
                    updated_at = CURRENT_TIMESTAMP
              WHERE position_id = $1`,
            [positionId, timestamp]
        );
    }

    async updatePositionClose(p: {
        positionId: string;
        outputNoteCommitment: string;
        closePrice: bigint;
        payout: bigint;
        fee: bigint;
    }) {
        await this.pool.query(
            `UPDATE positions
                SET is_closed = TRUE,
                    output_note_commitment = $2,
                    close_price = $3,
                    payout = $4,
                    fee = $5,
                    updated_at = CURRENT_TIMESTAMP
              WHERE position_id = $1`,
            [p.positionId, p.outputNoteCommitment, p.closePrice.toString(),
             p.payout.toString(), p.fee.toString()]
        );
    }

    /**
     * Record a liquidation.
     *
     * Marked closed with a payout of zero, which is what actually happened: the
     * collateral went to the keeper and the vault, and the owner received
     * nothing. Leaving the row open instead would show the owner a position
     * that no longer exists on-chain.
     */
    async updatePositionSeized(positionId: string) {
        await this.pool.query(
            `UPDATE positions
                SET is_closed = TRUE,
                    payout = 0,
                    updated_at = CURRENT_TIMESTAMP
              WHERE position_id = $1`,
            [positionId]
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
