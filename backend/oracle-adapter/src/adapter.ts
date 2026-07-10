import * as StellarSdk from '@stellar/stellar-sdk';

export class OracleAdapter {
    private server: StellarSdk.rpc.Server;
    private oracleContractId: string;
    
    // Max staleness in seconds (set to 1 year for testnet mock oracle)
    private maxStaleness: number = 31536000;

    constructor(rpcUrl: string, oracleContractId: string) {
        this.server = new StellarSdk.rpc.Server(rpcUrl);
        this.oracleContractId = oracleContractId;
    }

    async getAssetPrice(asset: string): Promise<{ price: number, timestamp: number, isStale: boolean }> {
        try {
            console.log(`Fetching price for ${asset} from Oracle ${this.oracleContractId}...`);

            const contract = new StellarSdk.Contract(this.oracleContractId);

            // Build the get_last_price() invocation (no arguments needed for dummy oracle)
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

            // Parse the result
            const successResult = simResult as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
            const returnValue = successResult.result?.retval;

            if (!returnValue) {
                throw new Error('No return value from simulation');
            }

            // Dummy oracle returns a tuple (i128, u64)
            const nativeResult = StellarSdk.scValToNative(returnValue);
            
            if (!nativeResult || !Array.isArray(nativeResult) || nativeResult.length !== 2) {
                throw new Error(`Oracle returned invalid tuple data for asset ${asset}`);
            }

            // Extracted values from tuple
            const price = Number(nativeResult[0]);
            const oracleTimestamp = Number(nativeResult[1]);
            
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
