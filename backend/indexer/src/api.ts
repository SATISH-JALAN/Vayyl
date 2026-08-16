import express from 'express';
import { Database } from './db.js';

export function createApi(db: Database, poolAddress: string, network: string): express.Express {
    const app = express();

    // The DApp fetches these read-only endpoints cross-origin (Vite on :3000 →
    // indexer on :3001 / Railway). Without CORS the browser blocks the response and the
    // withdraw Merkle-path reconstruction silently fails. Read-only public data,
    // so a permissive origin is fine for this read-only Mainnet demo API.
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });

    app.use(express.json());

    app.get('/health', async (req, res) => {
        // Surface leaf-set density: clients rebuild the Merkle tree from the
        // ordered commitment list, so a gap yields a wrong root and shows up
        // only as an opaque UnknownRoot when a user tries to spend.
        try {
            const { dense, count, maxIndex } = await db.assertDense(poolAddress);
            res.json({ status: 'ok', network, pool: poolAddress, commitmentsDense: dense, count, maxIndex });
        } catch (err: any) {
            res.status(500).json({ status: 'error', network, pool: poolAddress, error: err.message });
        }
    });

    /** Recipient scan feed — shielded-transfer outputs with their ephemeral points. */
    app.get('/transfers', async (req, res) => {
        try {
            const since = Number(req.query.since ?? 0);
            const transfers = await db.getTransfers(poolAddress, Number.isFinite(since) ? since : 0);
            res.json({ transfers });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/commitments', async (req, res) => {
        try {
            const commitments = await db.getCommitments(poolAddress);
            res.json({ commitments });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    /**
     * The full leaf set with provenance, for building and auditing a durable
     * tree snapshot. Refuses to serve a set with gaps: a snapshot built from a
     * sparse leaf list bakes in a wrong root permanently, which is worse than
     * having no snapshot at all.
     */
    app.get('/snapshot', async (req, res) => {
        try {
            const { dense, count, maxIndex } = await db.assertDense(poolAddress);
            if (!dense) {
                return res.status(409).json({
                    error: 'leaf set has gaps; refusing to serve a snapshot',
                    count,
                    maxIndex,
                });
            }
            const leaves = await db.getTreeSnapshot(poolAddress);
            const nullifiers = await db.getNullifiers(poolAddress);
            res.json({ network, pool: poolAddress, leafCount: leaves.length, leaves, nullifiers });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Deposits with public amounts — the clean-device recovery feed. */
    app.get('/deposits', async (req, res) => {
        try {
            res.json({ deposits: await db.getDeposits(poolAddress) });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/nullifiers', async (req, res) => {
        try {
            const nullifiers = await db.getNullifiers(poolAddress);
            res.json({ nullifiers });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/merkle-tree', async (req, res) => {
        try {
            const commitments = await db.getCommitments(poolAddress);
            // In a real implementation, we would reconstruct the full frontier tree here
            // using the same logic as the circuit/contract, or we can just return the leaves
            // and let the client construct it.
            res.json({ leaves: commitments, count: commitments.length });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/positions', async (req, res) => {
        try {
            const owner = req.query.owner as string | undefined;
            const positions = await db.getPositions(owner);
            res.json({ positions });
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    return app;
}
