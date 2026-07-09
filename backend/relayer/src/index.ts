import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { RelayerService } from './relay.js';
import * as StellarSdk from '@stellar/stellar-sdk';

dotenv.config();

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
const RELAYER_SECRET = process.env.RELAYER_SECRET;
const ALLOWED_POOLS = process.env.ALLOWED_POOLS ? process.env.ALLOWED_POOLS.split(',') : [];
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3002;

async function main() {
    console.log('Starting Vayyl Relayer...');

    if (!RELAYER_SECRET) {
        console.error('Error: RELAYER_SECRET environment variable is required');
        process.exit(1);
    }

    if (ALLOWED_POOLS.length === 0) {
        console.warn('Warning: ALLOWED_POOLS is empty, relayer will reject all transactions if fully implemented');
    }

    const relayer = new RelayerService(RPC_URL, RELAYER_SECRET, NETWORK_PASSPHRASE, ALLOWED_POOLS);
    
    const app = express();
    app.use(cors());
    app.use(express.json());

    const relayerPubkey = StellarSdk.Keypair.fromSecret(RELAYER_SECRET).publicKey();

    app.get('/health', (req, res) => {
        res.json({ status: 'ok', address: relayerPubkey });
    });

    app.post('/relay', async (req, res) => {
        const { tx } = req.body;
        
        if (!tx || typeof tx !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid "tx" parameter (expected base64 XDR)' });
        }

        try {
            const response = await relayer.relayTransaction(tx);
            res.json({ success: true, response });
        } catch (err: any) {
            console.error("Relay error:", err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.listen(PORT, () => {
        console.log(`Relayer API server listening on port ${PORT}`);
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
