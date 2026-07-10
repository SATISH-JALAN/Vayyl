const StellarSdk = require('@stellar/stellar-sdk');
const server = new StellarSdk.rpc.Server('https://soroban-testnet.stellar.org');
const kp = StellarSdk.Keypair.fromSecret('SBHLQ5SIWJNLJP3IRLNMNPH2BZKLJ3PX32MGWIWU6RIX5Y2PQAD66QTX');

async function check() {
  try {
    const acc = await server.getAccount(kp.publicKey());
    console.log('Relayer sequence:', acc.sequence);
    console.log('Relayer balance:', acc.balances);
  } catch (e) {
    console.error(e);
  }
}
check();
