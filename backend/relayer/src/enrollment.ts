import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import * as StellarSdk from '@stellar/stellar-sdk';

const { Pool } = pg;

const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

export const INITIAL_ASP_LEAVES = [
    '493303968121297919190709288514242366434035426510870016984691670712591500002',
    '9355251392402790607961937900655308684576976763364361612739956862647095463520',
    '14106331126009556338246032878453862687149273467692362284834967058553236230883',
    '6038008587679474091977388632319198517007692281305427930445766896380993899274',
    '431514013848352006058987078204336949099959250776040360314329397218955618469',
    '4239942066243959329816542514082134633918529370479969264234435216308986323128',
];

export function normalizeAspLeaf(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
        throw new Error('Enrollment handle must be a decimal field value');
    }
    const leaf = BigInt(value);
    if (leaf <= 0n || leaf >= FIELD_MODULUS) {
        throw new Error('Enrollment handle is outside the supported field');
    }
    return leaf.toString();
}

/**
 * Mirror of the on-chain ASP membership tree. It exists so the browser can
 * rebuild its ASP Merkle path locally; the contract remains the authority on
 * membership. Two implementations, because only enrollment needs durable
 * storage — relaying and withdrawal never touch it, and requiring Postgres to
 * serve those was blocking the whole service from starting.
 */
export interface AspLeafStore {
    init(): Promise<void>;
    getIndex(leaf: string): Promise<number | null>;
    getLeaves(): Promise<string[]>;
    count(): Promise<number>;
    upsert(index: number, leaf: string, txHash: string | null): Promise<void>;
}

/**
 * JSON-file store for deployments without Postgres.
 *
 * Durability matters here and is not optional: the membership contract exposes
 * `get_leaf_index`/`is_member` but no way to ENUMERATE leaves, so a lost list
 * cannot be rebuilt from chain. A purely in-memory store would drop every
 * post-boot enrollment on restart, and those users' deposits would then fail
 * with an ASP root mismatch they could do nothing about.
 */
class FileAspLeafStore implements AspLeafStore {
    private readonly path: string;
    private leaves = new Map<number, { leaf: string; txHash: string | null }>();

    constructor(path: string) {
        this.path = path;
    }

    async init(): Promise<void> {
        try {
            const raw = await readFile(this.path, 'utf8');
            for (const row of JSON.parse(raw) as Array<{ index: number; leaf: string; txHash: string | null }>) {
                this.leaves.set(row.index, { leaf: row.leaf, txHash: row.txHash ?? null });
            }
        } catch (err: any) {
            if (err?.code !== 'ENOENT') throw err;
        }
        for (const [index, leaf] of INITIAL_ASP_LEAVES.entries()) {
            if (!this.leaves.has(index)) this.leaves.set(index, { leaf, txHash: null });
        }
        await this.flush();
    }

    private async flush(): Promise<void> {
        const rows = [...this.leaves.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([index, v]) => ({ index, leaf: v.leaf, txHash: v.txHash }));
        await writeFile(this.path, JSON.stringify(rows, null, 2), 'utf8');
    }

    async getIndex(leaf: string): Promise<number | null> {
        for (const [index, v] of this.leaves) if (v.leaf === leaf) return index;
        return null;
    }

    async getLeaves(): Promise<string[]> {
        return [...this.leaves.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.leaf);
    }

    async count(): Promise<number> {
        return this.leaves.size;
    }

    async upsert(index: number, leaf: string, txHash: string | null): Promise<void> {
        const existing = this.leaves.get(index);
        this.leaves.set(index, { leaf, txHash: txHash ?? existing?.txHash ?? null });
        await this.flush();
    }
}

class PostgresAspLeafStore implements AspLeafStore {
    private readonly pool: pg.Pool;

    constructor(connectionString: string) {
        this.pool = new Pool({ connectionString });
    }

    async init(): Promise<void> {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS asp_membership_leaves (
                leaf_index INTEGER PRIMARY KEY,
                leaf_value TEXT UNIQUE NOT NULL,
                tx_hash TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        for (const [index, leaf] of INITIAL_ASP_LEAVES.entries()) {
            await this.upsert(index, leaf, null);
        }
    }

    async getIndex(leaf: string): Promise<number | null> {
        const result = await this.pool.query(
            'SELECT leaf_index FROM asp_membership_leaves WHERE leaf_value = $1',
            [leaf],
        );
        return result.rowCount ? Number(result.rows[0].leaf_index) : null;
    }

    async getLeaves(): Promise<string[]> {
        const result = await this.pool.query(
            'SELECT leaf_value FROM asp_membership_leaves ORDER BY leaf_index ASC',
        );
        return result.rows.map((row) => String(row.leaf_value));
    }

    async count(): Promise<number> {
        const result = await this.pool.query('SELECT COUNT(*)::int AS count FROM asp_membership_leaves');
        return Number(result.rows[0].count);
    }

    async upsert(index: number, leaf: string, txHash: string | null): Promise<void> {
        await this.pool.query(
            `INSERT INTO asp_membership_leaves (leaf_index, leaf_value, tx_hash)
             VALUES ($1, $2, $3)
             ON CONFLICT (leaf_index) DO UPDATE
             SET leaf_value = EXCLUDED.leaf_value,
                 tx_hash = COALESCE(EXCLUDED.tx_hash, asp_membership_leaves.tx_hash)`,
            [index, leaf, txHash],
        );
    }
}

export interface EnrollmentResult {
    leafIndex: number;
    txHash: string | null;
    leaves: string[];
}

export class AspEnrollmentService {
    private readonly server: StellarSdk.rpc.Server;
    private readonly admin: StellarSdk.Keypair;
    private readonly membership: StellarSdk.Contract;
    private readonly networkPassphrase: string;
    private readonly store: AspLeafStore;
    private readonly maxEnrollments: number;
    // ponytail: one process-wide queue avoids account-sequence races; use a
    // distributed lock only if this service is ever scaled past one replica.
    private queue: Promise<unknown> = Promise.resolve();

    constructor(options: {
        rpcUrl: string;
        networkPassphrase: string;
        adminSecret: string;
        membershipId: string;
        /** Postgres when available; otherwise the leaf list is file-backed. */
        databaseUrl?: string;
        leafStorePath?: string;
        maxEnrollments?: number;
    }) {
        this.server = new StellarSdk.rpc.Server(options.rpcUrl);
        this.admin = StellarSdk.Keypair.fromSecret(options.adminSecret);
        this.membership = new StellarSdk.Contract(options.membershipId);
        this.networkPassphrase = options.networkPassphrase;
        this.store = options.databaseUrl
            ? new PostgresAspLeafStore(options.databaseUrl)
            : new FileAspLeafStore(options.leafStorePath ?? './asp-leaves.json');
        this.backend = options.databaseUrl ? 'postgres' : 'file';
        this.maxEnrollments = options.maxEnrollments ?? 128;
    }

    /** Which store is in use — reported on /health so the mode is never a guess. */
    readonly backend: 'postgres' | 'file';

    async init(): Promise<void> {
        await this.store.init();
    }

    async getLeaves(): Promise<string[]> {
        return this.store.getLeaves();
    }

    enroll(value: unknown): Promise<EnrollmentResult> {
        const leaf = normalizeAspLeaf(value);
        const operation = this.queue.then(() => this.enrollSerial(leaf));
        this.queue = operation.catch(() => undefined);
        return operation;
    }

    private async enrollSerial(leaf: string): Promise<EnrollmentResult> {
        const storedIndex = await this.store.getIndex(leaf);
        if (storedIndex !== null) {
            return { leafIndex: storedIndex, txHash: null, leaves: await this.store.getLeaves() };
        }

        const chainIndex = await this.readLeafIndex(leaf);
        if (chainIndex !== null) {
            await this.store.upsert(chainIndex, leaf, null);
            return { leafIndex: chainIndex, txHash: null, leaves: await this.store.getLeaves() };
        }

        if (await this.store.count() >= this.maxEnrollments) {
            throw new Error('The public enrollment capacity has been reached');
        }

        const txHash = await this.insertLeaf(leaf);
        const leafIndex = await this.readLeafIndex(leaf);
        if (leafIndex === null) throw new Error('Enrollment confirmed but its membership index was unavailable');
        await this.store.upsert(leafIndex, leaf, txHash);
        return { leafIndex, txHash, leaves: await this.store.getLeaves() };
    }

    private fieldScVal(value: string): StellarSdk.xdr.ScVal {
        const bytes = Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex');
        return StellarSdk.xdr.ScVal.scvBytes(bytes);
    }

    private async readLeafIndex(leaf: string): Promise<number | null> {
        const source = await this.server.getAccount(this.admin.publicKey());
        const tx = new StellarSdk.TransactionBuilder(source, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(this.membership.call('get_leaf_index', this.fieldScVal(leaf)))
            .setTimeout(30)
            .build();
        const result = await this.server.simulateTransaction(tx);
        if (StellarSdk.rpc.Api.isSimulationError(result) || !result.result) return null;
        return Number(StellarSdk.scValToNative(result.result.retval));
    }

    private async insertLeaf(leaf: string): Promise<string> {
        const source = await this.server.getAccount(this.admin.publicKey());
        const tx = new StellarSdk.TransactionBuilder(source, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(this.membership.call('insert_leaf', this.fieldScVal(leaf)))
            .setTimeout(60)
            .build();
        const prepared = await this.server.prepareTransaction(tx);
        prepared.sign(this.admin);
        const sent = await this.server.sendTransaction(prepared);
        if (sent.status === 'ERROR') throw new Error('Enrollment transaction was rejected');

        for (let attempt = 0; attempt < 30; attempt++) {
            const result = await this.server.getTransaction(sent.hash);
            if (result.status === 'SUCCESS') return sent.hash;
            if (result.status === 'FAILED') throw new Error('Enrollment transaction failed on-chain');
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        throw new Error(`Timed out waiting for enrollment ${sent.hash}`);
    }
}
