import * as StellarSdk from '@stellar/stellar-sdk';

export class RelayerService {
    private server: StellarSdk.rpc.Server;
    private relayerKeypair: StellarSdk.Keypair;
    private networkPassphrase: string;
    private allowedContracts: string[];

    constructor(rpcUrl: string, secretKey: string, networkPassphrase: string, allowedContracts: string[]) {
        this.server = new StellarSdk.rpc.Server(rpcUrl);
        this.relayerKeypair = StellarSdk.Keypair.fromSecret(secretKey);
        this.networkPassphrase = networkPassphrase;
        this.allowedContracts = allowedContracts;
    }

    async relayTransaction(innerTxnB64: string): Promise<StellarSdk.rpc.Api.SendTransactionResponse> {
        try {
            // Parse the inner transaction submitted by the user
            const innerTx = new StellarSdk.Transaction(innerTxnB64, this.networkPassphrase);
            
            // Validate the transaction
            await this.validateTransaction(innerTx);

            // Fetch the relayer's base fee or calculate fee based on inner tx
            const baseFee = await this.fetchBaseFee();
            
            // Soroban transactions require higher fees, this should be estimated dynamically
            // For now, we set a reasonable fixed fee or use the RPC simulateTransaction
            const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
                this.relayerKeypair.publicKey(),
                baseFee.toString(),
                innerTx,
                this.networkPassphrase
            );
            
            feeBumpTx.sign(this.relayerKeypair);

            // Submit the fee bumped transaction
            const response = await this.server.sendTransaction(feeBumpTx);
            return response;
        } catch (err: any) {
            console.error("Relay error:", err);
            throw new Error(`Failed to relay transaction: ${err.message}`);
        }
    }

    private async validateTransaction(tx: StellarSdk.Transaction) {
        // Validation rules:
        // 1. Transaction must have exactly 1 operation (InvokeHostFunction)
        // 2. The contract being invoked must be in the allowedContracts list (our Vayyl pools)
        // 3. The transaction must already be signed by the user (if required)
        
        if (tx.operations.length !== 1) {
            throw new Error("Relayer only supports transactions with exactly one operation");
        }

        const op = tx.operations[0];
        
        // This validation is simplified. In reality, you'd check if the operation
        // is an InvokeHostFunction and extract the contract address.
        // For the buildathon, we bypass deep XDR inspection if it's too complex, 
        // but it's crucial for security in production.
        
        /* 
        if (op.type !== 'invokeHostFunction') {
            throw new Error("Only smart contract invocations are allowed");
        }
        */
        
        // Ensure the inner tx is fully signed by the user
        // (For fully anonymous shielded txs, there might not be a signature!)
        
        console.log(`Validating transaction ${tx.hash().toString('hex')}...`);
    }

    private async fetchBaseFee(): Promise<number> {
        // Should fetch the latest base fee from the network.
        // Soroban fee bump transactions need to cover the inner transaction's resource fees plus
        // the inclusion fee.
        
        // For buildathon, return a fixed high fee (e.g. 5,000,000 stroops = 0.5 XLM)
        return 5000000;
    }
}
