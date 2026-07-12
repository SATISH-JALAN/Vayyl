import dotenv from 'dotenv';
import { Database } from './db.js';
import { Poller } from './poller.js';
import { createApi } from './api.js';

dotenv.config();

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/vayyl_indexer';
const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const POOL_ADDRESS = process.env.POOL_ADDRESS;
const POSITION_MANAGER_ADDRESS = process.env.POSITION_MANAGER_ADDRESS;
const NETWORK = process.env.STELLAR_NETWORK || 'testnet';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

async function main() {
    console.log('Starting Vayyl Indexer...');

    if (!POOL_ADDRESS) {
        console.error('Error: POOL_ADDRESS environment variable is required');
        process.exit(1);
    }

    const db = new Database(DB_URL);
    await db.init();

    const app = createApi(db, POOL_ADDRESS, NETWORK);
    app.listen(PORT, () => {
        console.log(`API server listening on port ${PORT}`);
    });

    if (!POSITION_MANAGER_ADDRESS) {
        console.warn('Warning: POSITION_MANAGER_ADDRESS not set, will not index position events');
    }

    const poller = new Poller(RPC_URL, db, POOL_ADDRESS, POSITION_MANAGER_ADDRESS);
    poller.start().catch(err => {
        console.error('Poller crashed:', err);
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
