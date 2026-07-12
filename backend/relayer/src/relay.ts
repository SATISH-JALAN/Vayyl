import * as StellarSdk from '@stellar/stellar-sdk';

export class RelayerService {
    private server: StellarSdk.rpc.Server;
    private relayerKeypair: StellarSdk.Keypair;
    private networkPassphrase: string;
    private allowedContracts: string[];

    private static readonly FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

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

    async relayV2Withdraw(request: V2WithdrawRequest): Promise<string> {
        this.assertAllowedContract(request.pool);

        const source = await this.server.getAccount(this.relayerKeypair.publicKey());
        const contract = new StellarSdk.Contract(request.pool);
        const tx = new StellarSdk.TransactionBuilder(source, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(contract.call(
                'withdraw_v2',
                this.proofScVal(request.proof),
                this.fieldScVal(request.nullifier),
                new StellarSdk.Address(request.recipient).toScVal(),
                this.fieldScVal(request.root),
            ))
            .setTimeout(60)
            .build();

        const prepared = await this.server.prepareTransaction(tx);
        prepared.sign(this.relayerKeypair);
        const sent = await this.server.sendTransaction(prepared);
        if (sent.status === 'ERROR') {
            throw new Error(`Submission failed: ${sent.errorResult?.toXDR('base64') ?? 'unknown error'}`);
        }

        for (let attempt = 0; attempt < 30; attempt++) {
            const result = await this.server.getTransaction(sent.hash);
            if (result.status === 'SUCCESS') return sent.hash;
            if (result.status === 'FAILED') {
                throw new Error(`Transaction ${sent.hash} failed on-chain`);
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        throw new Error(`Timed out waiting for ${sent.hash}`);
    }

    private assertAllowedContract(contract: string) {
        if (!this.allowedContracts.includes(contract)) {
            throw new Error(`Contract ${contract} is not in the allowlist.`);
        }
    }

    private fieldBytes(value: string): Buffer {
        if (!/^[0-9]+$/.test(value)) throw new Error('Field values must be decimal strings');
        const field = BigInt(value);
        if (field < 0n || field >= RelayerService.FIELD_MODULUS) {
            throw new Error('Field value is outside the BN254 scalar field');
        }
        return Buffer.from(field.toString(16).padStart(64, '0'), 'hex');
    }

    private coordinateBytes(value: string): Buffer {
        if (!/^[0-9]+$/.test(value)) throw new Error('Proof coordinates must be decimal strings');
        const coordinate = BigInt(value);
        if (coordinate < 0n || coordinate >= (1n << 256n)) {
            throw new Error('Proof coordinate does not fit in 32 bytes');
        }
        return Buffer.from(coordinate.toString(16).padStart(64, '0'), 'hex');
    }

    private fieldScVal(value: string): StellarSdk.xdr.ScVal {
        return StellarSdk.xdr.ScVal.scvBytes(this.fieldBytes(value));
    }

    private proofScVal(proof: SnarkjsProof): StellarSdk.xdr.ScVal {
        const coordinate = (value: string) => this.coordinateBytes(value).toString('hex');
        if (proof.pi_a.length < 2 || proof.pi_b.length < 2 || proof.pi_c.length < 2) {
            throw new Error('Malformed Groth16 proof');
        }
        const a = coordinate(proof.pi_a[0]) + coordinate(proof.pi_a[1]);
        const b = coordinate(proof.pi_b[0][1]) + coordinate(proof.pi_b[0][0])
            + coordinate(proof.pi_b[1][1]) + coordinate(proof.pi_b[1][0]);
        const c = coordinate(proof.pi_c[0]) + coordinate(proof.pi_c[1]);
        const entry = (name: string, hex: string) => new StellarSdk.xdr.ScMapEntry({
            key: StellarSdk.xdr.ScVal.scvSymbol(name),
            val: StellarSdk.xdr.ScVal.scvBytes(Buffer.from(hex, 'hex')),
        });
        return StellarSdk.xdr.ScVal.scvMap([
            entry('a', a),
            entry('b', b),
            entry('c', c),
        ]);
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
             this.assertAllowedContract(contractAddress);
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

export interface SnarkjsProof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
}

export interface V2WithdrawRequest {
    pool: string;
    proof: SnarkjsProof;
    nullifier: string;
    recipient: string;
    root: string;
}
