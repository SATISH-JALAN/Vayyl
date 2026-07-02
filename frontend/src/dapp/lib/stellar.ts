import { rpc, Networks, Horizon } from '@stellar/stellar-sdk';

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const RPC_URL = 'https://soroban-testnet.stellar.org'; // Default testnet RPC

export const server = new rpc.Server(RPC_URL, { allowHttp: true });

// Contract IDs (Placeholders for now)
export const CONTRACTS = {
  VAYYL_POOL_XLM: 'C...', // Update when deployed
  VAYYL_POOL_USDC: 'C...',
  POSITION_MANAGER: 'C...',
};

const TESTNET_URL = 'https://horizon-testnet.stellar.org';
const MAINNET_URL = 'https://horizon.stellar.org';

export const getHorizonServer = (network: string) => {
  const url = network === 'TESTNET' ? TESTNET_URL : MAINNET_URL;
  return new Horizon.Server(url);
};

export const getNativeBalance = async (address: string, network: string) => {
  try {
    const horizon = getHorizonServer(network);
    const account = await horizon.loadAccount(address);
    const nativeBal = account.balances.find(b => b.asset_type === 'native');
    return nativeBal ? nativeBal.balance : '0';
  } catch (e) {
    // Account might not be created on ledger yet
    console.warn("Account not found or error fetching balance", e);
    return '0';
  }
};
