import * as StellarSdk from '@stellar/stellar-sdk';

export class OracleAdapter {
    private server: StellarSdk.rpc.Server;
    private oracleContractId: string;
    
    // Max staleness in seconds (e.g., 5 minutes)
    private maxStaleness: number = 300; 

    constructor(rpcUrl: string, oracleContractId: string) {
        this.server = new StellarSdk.rpc.Server(rpcUrl);
        this.oracleContractId = oracleContractId;
    }

    async getAssetPrice(asset: string): Promise<{ price: number, timestamp: number, isStale: boolean }> {
        try {
            console.log(`Fetching price for ${asset} from Oracle ${this.oracleContractId}...`);

            const contract = new StellarSdk.Contract(this.oracleContractId);

            // Build the get_last_price() invocation
            const call = contract.call('get_last_price');

            // Simulate the transaction to read the return value without submitting
            const simResult = await this.server.simulateTransaction(
                new StellarSdk.TransactionBuilder(
                    new StellarSdk.Account(
                        // Use a throw-away source for simulation (read-only call)
                        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
                        '0'
                    ),
                    {
                        fee: '100',
                        networkPassphrase: StellarSdk.Networks.TESTNET,
                    }
                )
                    .addOperation(call)
                    .setTimeout(30)
                    .build()
            );

            if (StellarSdk.rpc.Api.isSimulationError(simResult)) {
                throw new Error(`Simulation failed: ${(simResult as any).error}`);
            }

            // Parse the result — get_last_price returns (i128, u64) as a tuple
            const successResult = simResult as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
            const returnValue = successResult.result?.retval;

            if (!returnValue) {
                throw new Error('No return value from simulation');
            }

            // The return type is a Soroban tuple (Vec<ScVal>) containing [i128, u64]
            const tupleValues = returnValue.value() as any[];
            
            let price: number;
            let oracleTimestamp: number;

            if (Array.isArray(tupleValues) && tupleValues.length >= 2) {
                // Extract i128 price — Soroban i128 is encoded as { hi: i64, lo: u64 }
                const priceVal = tupleValues[0];
                if (priceVal && typeof priceVal.value === 'function') {
                    const pv = priceVal.value();
                    if (pv && pv.lo !== undefined && pv.hi !== undefined) {
                        price = Number(BigInt(pv.hi().toString()) * BigInt(2**64) + BigInt(pv.lo().toString()));
                    } else {
                        price = Number(pv);
                    }
                } else {
                    price = Number(priceVal);
                }

                // Extract u64 timestamp
                const tsVal = tupleValues[1];
                if (tsVal && typeof tsVal.value === 'function') {
                    oracleTimestamp = Number(tsVal.value());
                } else {
                    oracleTimestamp = Number(tsVal);
                }
            } else {
                // Fallback: try to parse as a simple value
                console.warn('Unexpected return format, attempting raw parse');
                price = 0;
                oracleTimestamp = 0;
            }
            
            const currentTimestamp = Math.floor(Date.now() / 1000);
            const isStale = (currentTimestamp - oracleTimestamp) > this.maxStaleness;

            return {
                price,
                timestamp: oracleTimestamp,
                isStale
            };
        } catch (err: any) {
            console.error("Oracle fetch error:", err.message || err);
            throw new Error(`Failed to fetch oracle price: ${err.message}`);
        }
    }
}
