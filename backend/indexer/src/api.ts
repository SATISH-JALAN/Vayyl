import express from 'express';
import { Database } from './db.js';

export function createApi(db: Database, poolAddress: string): express.Express {
    const app = express();
    
    app.use(express.json());

    app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    app.get('/commitments', async (req, res) => {
        try {
            const commitments = await db.getCommitments(poolAddress);
            res.json({ commitments });
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

    return app;
}
