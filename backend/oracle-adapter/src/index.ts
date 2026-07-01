import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OracleAdapter } from './adapter.js';

dotenv.config();

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const ORACLE_CONTRACT = process.env.ORACLE_CONTRACT || 'CD...'; // Replace with Reflector testnet contract ID
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;

async function main() {
    console.log('Starting Vayyl Oracle Adapter...');

    const adapter = new OracleAdapter(RPC_URL, ORACLE_CONTRACT);
    
    const app = express();
    app.use(cors());
    app.use(express.json());

    app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    app.get('/price/:asset', async (req, res) => {
        const asset = req.params.asset;
        try {
            const data = await adapter.getAssetPrice(asset);
            if (data.isStale) {
                return res.status(503).json({ 
                    error: 'Oracle price is stale', 
                    timestamp: data.timestamp,
                    current_time: Math.floor(Date.now() / 1000)
                });
            }
            res.json(data);
        } catch (err: any) {
            res.status(500).json({ error: err.message });
        }
    });

    app.listen(PORT, () => {
        console.log(`Oracle Adapter API server listening on port ${PORT}`);
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
