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
            // Reflector smart contract interface simulation
            // For the buildathon, we simulate an RPC call to the actual Reflector Oracle contract.
            // A real integration uses the exact XDR for Reflector's `lastprice` function.
            
            // Example Reflector call structure (simplified)
            // let args = [StellarSdk.xdr.ScVal.scvSymbol("XLM")]
            
            console.log(`Fetching price for ${asset} from Oracle ${this.oracleContractId}...`);

            // SIMULATED RESPONSE
            // In a real app, parse the xdr returned from simulateTransaction or invokeHostFunction
            const currentTimestamp = Math.floor(Date.now() / 1000);
            
            const simulatedPrice = 0.50; // $0.50 per XLM
            const simulatedOracleTimestamp = currentTimestamp - 60; // 1 minute old
            
            const isStale = (currentTimestamp - simulatedOracleTimestamp) > this.maxStaleness;

            return {
                price: simulatedPrice,
                timestamp: simulatedOracleTimestamp,
                isStale
            };
        } catch (err: any) {
            console.error("Oracle fetch error:", err);
            throw new Error(`Failed to fetch oracle price: ${err.message}`);
        }
    }
}
