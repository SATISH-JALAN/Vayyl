import * as StellarSdk from '@stellar/stellar-sdk';

async function main() {
    const server = new StellarSdk.rpc.Server('https://soroban-testnet.stellar.org');
    const oracleId = 'CAVLP5DH2GJPZMVO7IJY4CVOD5MWEFTJFVPD2YY2FQXOQHRGHK4D6HLP';
    
    const contract = new StellarSdk.Contract(oracleId);
    
    // Asset::Other(Symbol("XLM"))
    const assetArg = StellarSdk.xdr.ScVal.scvVec([
        StellarSdk.xdr.ScVal.scvSymbol('Other'),
        StellarSdk.xdr.ScVal.scvSymbol('XLM')
    ]);

    const call = contract.call('lastprice', assetArg);

    const simResult = await server.simulateTransaction(
        new StellarSdk.TransactionBuilder(
            new StellarSdk.Account(
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
        console.error('Error:', simResult.error);
        return;
    }

    const successResult = simResult as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
    const retval = successResult.result?.retval;

    if (retval) {
        console.log('Raw XDR:', retval.toXDR('base64'));
        const native = StellarSdk.scValToNative(retval);
        console.log('Native:', native);
    }
}

main().catch(console.error);
