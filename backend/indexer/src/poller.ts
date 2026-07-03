import * as StellarSdk from '@stellar/stellar-sdk';
import { Database } from './db.js';
import { decodePoolEvent } from './decode.js';

export class Poller {
    private server: StellarSdk.rpc.Server;
    private db: Database;
    private rpcUrl: string;
    private poolAddress: string;
    private running = false;

    constructor(rpcUrl: string, db: Database, poolAddress: string) {
        this.server = new StellarSdk.rpc.Server(rpcUrl, { allowHttp: true });
        this.db = db;
        this.rpcUrl = rpcUrl;
        this.poolAddress = poolAddress;
    }

    async start() {
        console.log(`Starting poller for pool: ${this.poolAddress} on RPC: ${this.rpcUrl}`);
        this.running = true;
        let lastLedger = await this.db.getLastLedger();

        // If we have no cursor yet, start from the RPC's oldest retained ledger
        // (events are only retained ~7 days; older history must be backfilled
        // from an archive — out of scope for the buildathon).
        if (lastLedger <= 0) {
            try {
                const latest = await this.server.getLatestLedger();
                // getEvents requires a startLedger within retention; step back a
                // safe window and let the RPC clamp/report the real oldest.
                lastLedger = Math.max(1, latest.sequence - 17280); // ~1 day of ledgers
            } catch (e) {
                console.warn('Could not fetch latest ledger; starting from 1', e);
                lastLedger = 1;
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
        let processedThroughLedger = fromLedger;
        let sawAny = false;

        // Follow pagination within this tick until the page isn't full.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const req: StellarSdk.rpc.Server.GetEventsRequest = {
                filters: [
                    {
                        type: 'contract',
                        contractIds: [this.poolAddress],
                        topics: [],
                    },
                ],
                limit: 100,
            };
            if (cursor) req.cursor = cursor;
            else req.startLedger = fromLedger;

            const response = await this.server.getEvents(req);
            const events = response.events ?? [];

            for (const event of events) {
                await this.processEvent(event);
                sawAny = true;
                if (typeof event.ledger === 'number') {
                    processedThroughLedger = Math.max(processedThroughLedger, event.ledger);
                }
            }

            cursor = (response as any).cursor;
            // Stop paginating when the page wasn't full (caught up).
            if (events.length < 100) {
                // Advance to the network head only when there were no events to
                // miss; otherwise stay at the last processed ledger + 1.
                const head = response.latestLedger ?? processedThroughLedger;
                const next = sawAny ? processedThroughLedger + 1 : head;
                await this.db.setLastLedger(next);
                return next;
            }
        }
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
                    // Transfer commitments have no on-chain leaf index in the event;
                    // record with -1 (unknown) — refined if/when transfer ships.
                    await this.db.insertCommitment(this.poolAddress, decoded.commitment1, -1, txHash, ledgerSeq);
                    await this.db.insertCommitment(this.poolAddress, decoded.commitment2, -1, txHash, ledgerSeq);
                    console.log(`Transfer: 2 nullifiers spent, 2 commitments added`);
                    break;
            }
        } catch (e: any) {
            console.error(`Failed to process event ${(event as any).id ?? ''}:`, e?.message ?? e);
        }
    }
}
