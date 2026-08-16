import * as StellarSdk from '@stellar/stellar-sdk';
import { Database } from './db.js';
import { decodePoolEvent } from './decode.js';

// Fallback backfill floor when neither a stored cursor nor INDEXER_START_LEDGER
// is available. Deliberately short: it only has to cover a restart gap, because
// a first-time index of an existing pool should set INDEXER_START_LEDGER to the
// pool's deployment ledger instead of relying on this.
const RPC_EVENT_LOOKBACK_LEDGERS = 8_000;

// getEvents scans a bounded ledger window per call and returns an EMPTY page —
// with a cursor to continue from — whenever that window contains no matching
// event. An empty page therefore means "nothing here yet", NOT "caught up";
// backfilling the live pool from its deploy ledger took 14 pages, 13 of them
// empty. Treating a short page as terminal silently skips the whole range.
const MAX_PAGES_PER_TICK = 400;

export class Poller {
    private server: StellarSdk.rpc.Server;
    private db: Database;
    private rpcUrl: string;
    private poolAddress: string;
    private positionManagerAddress?: string;
    private running = false;

    constructor(rpcUrl: string, db: Database, poolAddress: string, positionManagerAddress?: string) {
        this.server = new StellarSdk.rpc.Server(rpcUrl, { allowHttp: true });
        this.db = db;
        this.rpcUrl = rpcUrl;
        this.poolAddress = poolAddress;
        this.positionManagerAddress = positionManagerAddress;
    }

    async start() {
        console.log(`Starting poller for pool: ${this.poolAddress} on RPC: ${this.rpcUrl}`);
        this.running = true;
        let lastLedger = await this.db.getLastLedger(this.poolAddress);

        // With no stored cursor, prefer an explicit backfill floor. Set
        // INDEXER_START_LEDGER to the pool's deployment ledger: RPC retains
        // events for only ~7 days, so anything older needs an archive, but
        // everything since deployment is recoverable and MUST be indexed —
        // clients rebuild the Merkle tree from the full commitment list, so a
        // missing early leaf breaks spending for every later note too.
        if (lastLedger <= 0) {
            const configured = Number(process.env.INDEXER_START_LEDGER ?? 0);
            if (Number.isFinite(configured) && configured > 0) {
                lastLedger = configured;
            } else {
                try {
                    const latest = await this.server.getLatestLedger();
                    lastLedger = Math.max(1, latest.sequence - RPC_EVENT_LOOKBACK_LEDGERS);
                    console.warn(
                        `INDEXER_START_LEDGER not set; starting ${RPC_EVENT_LOOKBACK_LEDGERS} ledgers back ` +
                        `(${lastLedger}). Events older than that will be missed.`
                    );
                } catch (e) {
                    console.warn('Could not fetch latest ledger; starting from 1', e);
                    lastLedger = 1;
                }
            }
        }
        console.log(`Resuming from ledger: ${lastLedger}`);

        while (this.running) {
            try {
                lastLedger = await this.pollOnce(lastLedger);
            } catch (err: any) {
                // On error, do NOT advance the cursor — retry the same range.
                console.error('Error polling events:', err?.message ?? err);
            }
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }

    stop() {
        this.running = false;
    }

    /**
     * Poll one page (or several, following pagination cursors) starting at
     * `fromLedger`. Persists every recognised event, and only returns an
     * advanced ledger cursor for ledgers we actually processed.
     */
    async pollOnce(fromLedger: number): Promise<number> {
        let cursor: string | undefined = undefined;
        let startLedger = fromLedger;
        let processedThroughLedger = fromLedger;
        let scannedThroughLedger = 0;
        let head = 0;
        let pages = 0;

        // Follow pagination until the cursor is exhausted. An empty page is NOT
        // a stop condition — see MAX_PAGES_PER_TICK above.
        while (pages < MAX_PAGES_PER_TICK) {
            const contractIds = [this.poolAddress];
            if (this.positionManagerAddress) {
                contractIds.push(this.positionManagerAddress);
            }

            const filters: StellarSdk.rpc.Api.EventFilter[] = [{
                type: 'contract',
                contractIds,
            }];
            const req: StellarSdk.rpc.Server.GetEventsRequest = cursor
                ? { filters, cursor, limit: 100 }
                : { filters, startLedger, limit: 100 };

            let response: StellarSdk.rpc.Api.GetEventsResponse;
            try {
                response = await this.server.getEvents(req);
            } catch (err: any) {
                // The retention window slides forward continuously. If our floor
                // has aged out, clamp to the oldest retained ledger rather than
                // wedging the service forever on an unsatisfiable request.
                const floor = Poller.parseRetentionFloor(err);
                if (floor !== null && !cursor && floor > startLedger) {
                    console.warn(
                        `Start ledger ${startLedger} is outside RPC retention; ` +
                        `clamping to ${floor}. Events before ${floor} are unrecoverable from RPC.`
                    );
                    startLedger = floor;
                    continue;
                }
                throw err;
            }

            const events = response.events ?? [];
            pages++;
            head = response.latestLedger ?? head;

            for (const event of events) {
                await this.processEvent(event);
                if (typeof event.ledger === 'number') {
                    processedThroughLedger = Math.max(processedThroughLedger, event.ledger);
                }
            }

            const nextCursor = (response as any).cursor as string | undefined;
            // The cursor encodes the ledger the scan reached, which is the only
            // reliable resume point across a run of empty pages.
            const cursorLedger = Poller.parseCursorLedger(nextCursor);
            if (cursorLedger !== null) {
                scannedThroughLedger = Math.max(scannedThroughLedger, cursorLedger);
            }

            if (!nextCursor || nextCursor === cursor) {
                // Cursor exhausted: everything up to the head has been scanned.
                const next = Math.max(head || processedThroughLedger, processedThroughLedger + 1);
                await this.db.setLastLedger(this.poolAddress, next);
                return next;
            }
            cursor = nextCursor;
        }

        // Hit the per-tick page cap mid-backfill. Persist only how far we
        // actually scanned so the next tick resumes there instead of skipping.
        const next = Math.max(scannedThroughLedger, processedThroughLedger) + 1;
        await this.db.setLastLedger(this.poolAddress, next);
        console.log(`Backfill in progress; resuming from ledger ${next}`);
        return next;
    }

    /** Oldest retained ledger from a getEvents range rejection, if present. */
    private static parseRetentionFloor(err: any): number | null {
        const message = err?.message ?? err?.response?.data?.error?.message ?? '';
        const match = /ledger range:\s*(\d+)\s*-\s*(\d+)/.exec(String(message));
        // +1 keeps us clear of the floor sliding forward between the error and
        // the retry; the boundary ledger itself is about to age out anyway.
        return match ? Number(match[1]) + 1 : null;
    }

    /** Leading ledger sequence from an RPC cursor ("0003927049-0000000001"). */
    private static parseCursorLedger(cursor: string | undefined): number | null {
        if (!cursor) return null;
        const match = /^(\d+)/.exec(cursor);
        if (!match) return null;
        const ledger = Number(match[1]);
        return Number.isFinite(ledger) && ledger > 0 ? ledger : null;
    }

    private async processEvent(event: StellarSdk.rpc.Api.EventResponse) {
        try {
            const topic = (event as any).topic as StellarSdk.xdr.ScVal[];
            const value = (event as any).value as StellarSdk.xdr.ScVal;
            const decoded = decodePoolEvent(topic, value);
            if (!decoded) return;

            const txHash = (event as any).txHash ?? '';
            const ledgerSeq = (event as any).ledger ?? 0;

            switch (decoded.kind) {
                case 'deposit':
                    await this.db.insertCommitment(
                        this.poolAddress,
                        decoded.commitment,
                        decoded.leafIndex,
                        txHash,
                        ledgerSeq,
                    );
                    console.log(
                        `Deposit: commitment=${decoded.commitment.slice(0, 12)}… leaf=${decoded.leafIndex} amount=${decoded.amount}`,
                    );
                    break;
                case 'withdraw':
                    await this.db.insertNullifier(this.poolAddress, decoded.nullifier, txHash, ledgerSeq);
                    console.log(`Withdraw: nullifier=${decoded.nullifier.slice(0, 12)}… amount=${decoded.amount}`);
                    break;
                case 'transfer':
                    await this.db.insertNullifier(this.poolAddress, decoded.nullifier1, txHash, ledgerSeq);
                    await this.db.insertNullifier(this.poolAddress, decoded.nullifier2, txHash, ledgerSeq);
                    // The V1 transfer event carries NO leaf index, so these
                    // commitments cannot be placed in the tree. They used to be
                    // written with -1, which sorted them ahead of every deposit
                    // in `getCommitments` (ORDER BY leaf_index ASC) and shifted
                    // every leaf index — silently breaking Merkle-path
                    // reconstruction, and therefore withdrawals, for ALL users.
                    // Recording nothing is strictly better than recording a lie:
                    // V1 transfer is unreachable on a V2 pool, and transfer_v2
                    // emits the index it needs.
                    console.error(
                        `V1 transfer at ${txHash}: commitments ${decoded.commitment1.slice(0, 12)}…/` +
                        `${decoded.commitment2.slice(0, 12)}… carry no leaf index and were NOT indexed. ` +
                        `Merkle paths for this pool are incomplete.`,
                    );
                    break;
                case 'transferV3':
                    await this.db.insertNullifier(this.poolAddress, decoded.nullifier1, txHash, ledgerSeq);
                    await this.db.insertNullifier(this.poolAddress, decoded.nullifier2, txHash, ledgerSeq);
                    for (const out of decoded.outputs) {
                        await this.db.insertCommitment(
                            this.poolAddress, out.commitment, out.leafIndex, txHash, ledgerSeq,
                            {
                                source: 'transfer',
                                ephemeralX: out.ephemeralX,
                                ephemeralY: out.ephemeralY,
                                amountCipher: out.amountCipher,
                            },
                        );
                    }
                    console.log(
                        `TransferV3: spent ${decoded.nullifier1.slice(0, 10)}…/${decoded.nullifier2.slice(0, 10)}… ` +
                        `-> leaves ${decoded.outputs.map((o) => o.leafIndex).join(', ')} (amounts private)`,
                    );
                    break;
                case 'rageQuitV2':
                    // Spend only — rage-quit inserts no leaf, so there is no
                    // commitment to place in the tree.
                    await this.db.insertNullifier(this.poolAddress, decoded.nullifier, txHash, ledgerSeq);
                    console.log(
                        `RageQuit: nullifier=${decoded.nullifier.slice(0, 12)}… ` +
                        `commitment=${decoded.commitment.slice(0, 12)}… (public exit) amount=${decoded.amount}`,
                    );
                    break;
                case 'transferV2':
                    await this.db.insertNullifier(this.poolAddress, decoded.nullifier, txHash, ledgerSeq);
                    await this.db.insertCommitment(
                        this.poolAddress,
                        decoded.commitment,
                        decoded.leafIndex,
                        txHash,
                        ledgerSeq,
                        {
                            source: 'transfer',
                            ephemeralX: decoded.ephemeralX,
                            ephemeralY: decoded.ephemeralY,
                        },
                    );
                    console.log(
                        `TransferV2: nullifier=${decoded.nullifier.slice(0, 12)}… ` +
                        `commitment=${decoded.commitment.slice(0, 12)}… leaf=${decoded.leafIndex}`,
                    );
                    break;
                case 'PositionOpen':
                    await this.db.insertPosition(decoded.positionId, decoded.owner, decoded.commitment, decoded.direction, decoded.size);
                    console.log(`PositionOpen: id=${decoded.positionId.slice(0, 12)}... owner=${decoded.owner}`);
                    break;
                case 'PositionHealth':
                    await this.db.updatePositionHealth(decoded.positionId, decoded.timestamp);
                    console.log(`PositionHealth: id=${decoded.positionId.slice(0, 12)}... timestamp=${decoded.timestamp}`);
                    break;
                case 'PositionClose':
                    await this.db.updatePositionClose(decoded.positionId, decoded.newCommitment);
                    console.log(`PositionClose: id=${decoded.positionId.slice(0, 12)}...`);
                    break;
            }
        } catch (e: any) {
            console.error(`Failed to process event ${(event as any).id ?? ''}:`, e?.message ?? e);
        }
    }
}
