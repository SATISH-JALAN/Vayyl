import * as StellarSdk from '@stellar/stellar-sdk';
import { Database } from './db.js';

export class Poller {
    private server: StellarSdk.rpc.Server;
    private db: Database;
    private rpcUrl: string;
    private poolAddress: string;

    constructor(rpcUrl: string, db: Database, poolAddress: string) {
        this.server = new StellarSdk.rpc.Server(rpcUrl);
        this.db = db;
        this.rpcUrl = rpcUrl;
        this.poolAddress = poolAddress;
    }

    async start() {
        console.log(`Starting poller for pool: ${this.poolAddress} on RPC: ${this.rpcUrl}`);
        let lastLedger = await this.db.getLastLedger();
        console.log(`Resuming from ledger: ${lastLedger}`);

        // Simple polling loop
        while (true) {
            try {
                // We're querying events. In production, paginate via cursor.
                // For the buildathon, we simplify by just getting latest ledgers.
                const response = await this.server.getEvents({
                    startLedger: lastLedger > 0 ? lastLedger + 1 : undefined,
                    filters: [
                        {
                            type: "contract",
                            contractIds: [this.poolAddress],
                            topics: [] // Listen to all topics for this contract
                        }
                    ],
                    limit: 1000
                });

                if (response.events && response.events.length > 0) {
                    for (const event of response.events) {
                        await this.processEvent(event);
                    }
                    
                    // Update last ledger
                    lastLedger = response.latestLedger;
                    await this.db.setLastLedger(lastLedger);
                } else {
                    // Update ledger even if no events
                    lastLedger = response.latestLedger;
                    await this.db.setLastLedger(lastLedger);
                }
            } catch (err) {
                console.error("Error polling events:", err);
            }

            // Sleep for 5 seconds
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    private async processEvent(event: any) {
        // Here we parse the XDR event data.
        // The VayylPool contract emits events internally via the log! macro currently.
        // A full implementation requires structured events via env.events().publish().
        // For the demo/buildathon, we simulate picking up the parsed event:
        
        console.log(`Processing event from tx: ${event.txHash}`);
        
        // Pseudo-logic to simulate parsing event topics:
        // if topic[0] == symbol("Deposit") { ... }
        // if topic[0] == symbol("Transfer") { ... }
        
        // The actual extraction requires decoding the XDR. 
        // We will just log it for now.
    }
}
