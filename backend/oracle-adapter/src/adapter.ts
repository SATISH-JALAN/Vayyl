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

            // Reflector uses Asset::Other(Symbol) for non-Stellar native assets
            // In XDR, this is represented as a Vec with the variant name 'Other' followed by the symbol
            const assetArg = StellarSdk.xdr.ScVal.scvVec([
                StellarSdk.xdr.ScVal.scvSymbol('Other'),
                StellarSdk.xdr.ScVal.scvSymbol(asset)
            ]);

            // Build the lastprice() invocation
            const call = contract.call('lastprice', assetArg);

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

            // Reflector returns Option<PriceData> where PriceData is a struct { price: i128, timestamp: u64 }
            // scValToNative handles this beautifully
            const nativeResult = StellarSdk.scValToNative(returnValue);
            
            if (!nativeResult) {
                throw new Error(`Oracle returned no data for asset ${asset}`);
            }

            // Extracted values
            const price = Number(nativeResult.price);
            const oracleTimestamp = Number(nativeResult.timestamp);
            
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
