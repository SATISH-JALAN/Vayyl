import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { RelayerService, type V2WithdrawRequest, type V2TransferRequest } from './relay.js';
import { AspEnrollmentService } from './enrollment.js';
import * as StellarSdk from '@stellar/stellar-sdk';

dotenv.config();

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const RELAYER_SECRET = process.env.RELAYER_SECRET;
const ASP_ADMIN_SECRET = process.env.ASP_ADMIN_SECRET;
const ASP_MEMBERSHIP_ID = process.env.ASP_MEMBERSHIP_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const ASP_MAX_ENROLLMENTS = Number(process.env.ASP_MAX_ENROLLMENTS ?? 128);
const ASP_LEAF_STORE_PATH = process.env.ASP_LEAF_STORE_PATH;
const ALLOWED_POOLS = process.env.ALLOWED_POOLS ? process.env.ALLOWED_POOLS.split(',') : [];
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3002;

async function main() {
    console.log('Starting Vayyl Relayer...');

    // Only relaying is mandatory. ASP enrollment is a separate concern with its
    // own credentials, and bundling them meant a missing DATABASE_URL stopped
    // the service from starting at all — including /relay, /v2/withdraw and
    // /v2/transfer, none of which touch the database.
    if (!RELAYER_SECRET) {
        console.error('Error: RELAYER_SECRET is required');
        process.exit(1);
    }

    if (ALLOWED_POOLS.length === 0) {
        console.warn('Warning: ALLOWED_POOLS is empty, relayer will reject all transactions if fully implemented');
    }

    const relayer = new RelayerService(RPC_URL, RELAYER_SECRET, NETWORK_PASSPHRASE, ALLOWED_POOLS);

    let enrollment = (ASP_ADMIN_SECRET && ASP_MEMBERSHIP_ID)
        ? new AspEnrollmentService({
            rpcUrl: RPC_URL,
            networkPassphrase: NETWORK_PASSPHRASE,
            adminSecret: ASP_ADMIN_SECRET,
            membershipId: ASP_MEMBERSHIP_ID,
            databaseUrl: DATABASE_URL,           // absent -> file-backed store
            leafStorePath: ASP_LEAF_STORE_PATH,
            maxEnrollments: ASP_MAX_ENROLLMENTS,
        })
        : null;

    if (enrollment) {
        await enrollment.init();
        // Serving an ASP path that disagrees with the chain is worse than
        // serving none: the client builds a root the pool rejects, and the
        // deposit fails with an error that never mentions enrollment. Refuse
        // to enrol on drift, but keep relaying up — /relay, /v2/withdraw and
        // /v2/transfer never touch the ASP tree.
        const consistency = await enrollment.verifyAgainstChain();
        if (!consistency.ok) {
            console.error(
                `ASP enrollment DISABLED: local leaf mirror disagrees with the membership ` +
                `contract (${consistency.reason}). Deposits would be rejected on an ASP-root ` +
                `mismatch. Re-seed INITIAL_ASP_LEAVES from the live tree, or clear the leaf ` +
                `store, before enabling enrollment.`,
            );
            enrollment = null;
        } else {
            console.log(`ASP enrollment enabled (${enrollment.backend}-backed leaf store)`);
        }
    } else {
        console.warn(
            'ASP enrollment DISABLED: set ASP_ADMIN_SECRET and ASP_MEMBERSHIP_ID to enable it. ' +
            '/v2/enroll and /v2/asp/leaves will return 503; relaying is unaffected.',
        );
    }
    
    const app = express();
    app.set('trust proxy', 1);
    app.use(cors());
    app.use(express.json({ limit: '128kb' }));

    // ponytail: process-local testnet limiter; replace with shared storage only
    // if the relayer is horizontally scaled.
    const requestWindows = new Map<string, { started: number; count: number }>();
    const enrollmentWindows = new Map<string, { started: number; count: number }>();
    app.use((req, res, next) => {
        if (req.method !== 'POST') return next();
        const key = req.ip || 'unknown';
        const now = Date.now();
        const current = requestWindows.get(key);
        const window = !current || now - current.started >= 60_000
            ? { started: now, count: 0 }
            : current;
        window.count += 1;
        requestWindows.set(key, window);
        if (window.count > 30) return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
        if (req.path === '/v2/enroll') {
            const enrollmentWindow = enrollmentWindows.get(key);
            const currentEnrollment = !enrollmentWindow || now - enrollmentWindow.started >= 60_000
                ? { started: now, count: 0 }
                : enrollmentWindow;
            currentEnrollment.count += 1;
            enrollmentWindows.set(key, currentEnrollment);
            if (currentEnrollment.count > 3) {
                return res.status(429).json({ success: false, error: 'Enrollment rate limit exceeded' });
            }
        }
        next();
    });

    const relayerPubkey = StellarSdk.Keypair.fromSecret(RELAYER_SECRET).publicKey();
    const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);

    const enrollmentMode = enrollment ? enrollment.backend : 'disabled';

    app.get('/health', async (req, res) => {
        try {
            const account = await horizon.loadAccount(relayerPubkey);
            const native = account.balances.find((balance) => balance.asset_type === 'native');
            res.json({
                status: 'ok',
                address: relayerPubkey,
                nativeBalance: native?.balance ?? '0',
                enrollment: enrollmentMode,
            });
        } catch {
            res.json({ status: 'ok', address: relayerPubkey, nativeBalance: null, enrollment: enrollmentMode });
        }
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

    const enrollmentUnavailable = { error: 'ASP enrollment is not configured on this relayer.' };

    app.get('/v2/asp/leaves', async (_req, res) => {
        if (!enrollment) return res.status(503).json(enrollmentUnavailable);
        try {
            res.json({ leaves: await enrollment.getLeaves() });
        } catch (err: any) {
            res.status(503).json({ error: err?.message ?? 'Membership state unavailable' });
        }
    });

    app.post('/v2/enroll', async (req, res) => {
        if (!enrollment) return res.status(503).json({ success: false, ...enrollmentUnavailable });
        try {
            const result = await enrollment.enroll(req.body?.leaf);
            res.json({ success: true, ...result });
        } catch (err: any) {
            console.error('Enrollment error:', err?.message ?? err);
            res.status(400).json({ success: false, error: err?.message ?? 'Enrollment failed' });
        }
    });

    app.post('/v2/withdraw', async (req, res) => {
        try {
            const hash = await relayer.relayV2Withdraw(req.body as V2WithdrawRequest);
            res.json({ success: true, hash });
        } catch (err: any) {
            console.error('V2 relay error:', err);
            res.status(400).json({ success: false, error: err?.message ?? 'Withdrawal relay failed' });
        }
    });

    app.post('/v2/transfer', async (req, res) => {
        try {
            const hash = await relayer.relayV2Transfer(req.body as V2TransferRequest);
            res.json({ success: true, hash });
        } catch (err: any) {
            console.error('V2 transfer relay error:', err);
            res.status(400).json({ success: false, error: err?.message ?? 'Transfer relay failed' });
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
