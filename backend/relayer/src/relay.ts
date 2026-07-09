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
            const baseFee = await this.fetchBaseFee(innerTx);
            
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

        const op = tx.operations[0] as StellarSdk.Operation.InvokeHostFunction;
        
        if (op.type !== 'invokeHostFunction') {
            throw new Error("Only smart contract invocations are allowed");
        }
        
        const func = op.func;
        if (func.switch().name === 'hostFunctionTypeInvokeContract') {
             const invokeArgs = func.invokeContract();
             const contractIdXdr = invokeArgs.contractAddress();
             const contractAddress = StellarSdk.Address.fromScAddress(contractIdXdr).toString();
             if (!this.allowedContracts.includes(contractAddress)) {
                 throw new Error(`Contract ${contractAddress} is not in the allowlist.`);
             }
        }
        
        console.log(`Validated transaction ${tx.hash().toString('hex')} targeting allowed contract.`);
    }

    private async fetchBaseFee(innerTx: StellarSdk.Transaction): Promise<number> {
        try {
            const simulated = await this.server.simulateTransaction(innerTx);
            if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
                throw new Error(simulated.error);
            }
            
            const minResourceFee = BigInt(simulated.minResourceFee);
            const inclusionFee = BigInt(100_000); 
            
            return Number(minResourceFee + inclusionFee);
        } catch (e: any) {
            console.error("Simulation failed, falling back to fixed fee", e);
            return 5000000;
        }
    }
}
