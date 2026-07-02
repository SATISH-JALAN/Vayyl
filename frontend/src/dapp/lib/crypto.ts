export function generateBlindness(): string {
  // Generate 32 bytes of random data for the blindness factor
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  
  // Convert to hex string (simplification for the UI demo)
  return Array.from(array)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

import * as snarkjs from 'snarkjs';

export async function computeCommitment(amount: string, blindness: string, pubKey: string): Promise<string> {
  // Use hash4.wasm to compute Poseidon2_4(amount, pubX, pubY, blindness)
  // We assume pubKey is a single element for this demo (or pubX, pubY derived)
  // For simplicity, we use pubKey as both X and Y or just pad
  const inputs = {
    in: [amount, pubKey, "0", blindness]
  };
  
  // @ts-ignore - snarkjs types are inaccurate for browser memory files
  const wtns = await snarkjs.wtns.calculate(inputs, "/circuits/hash4.wasm", { type: "mem" });
  // @ts-ignore
  const res: any = await snarkjs.wtns.exportJson(wtns);
  
  // The output is the second element in the witness (index 1)
  // Return it as a hex string
  const hash = BigInt(res[1]).toString(16);
  return '0x' + hash;
}

export async function computeNullifier(commitment: string, privKey: string): Promise<string> {
  // Use hash2.wasm to compute Poseidon2_2(commitment, privKey)
  const inputs = {
    in: [commitment, privKey]
  };
  
  // @ts-ignore
  const wtns = await snarkjs.wtns.calculate(inputs, "/circuits/hash2.wasm", { type: "mem" });
  // @ts-ignore
  const res: any = await snarkjs.wtns.exportJson(wtns);
  
  const hash = BigInt(res[1]).toString(16);
  return '0x' + hash;
}

import { signMessage } from '@stellar/freighter-api';

export const VAYYL_AUTH_MESSAGE = "Authenticate with Vayyl to derive your private viewing key. DO NOT SIGN THIS on untrusted domains.";

export const deriveViewingKey = async (): Promise<string> => {
  // 1. Request signature from Freighter
  const signatureResponse = await signMessage(VAYYL_AUTH_MESSAGE, { networkPassphrase: 'Test SDF Network ; September 2015' });
  if (signatureResponse.error) {
    throw new Error(signatureResponse.error);
  }
  
  let signedMessage: string = "";
  
  if (signatureResponse instanceof Uint8Array) {
     signedMessage = new TextDecoder().decode(signatureResponse);
  } else if (typeof signatureResponse === 'string') {
      signedMessage = signatureResponse;
  } else if (signatureResponse.signedMessage) {
      if (typeof signatureResponse.signedMessage === 'string') {
          signedMessage = signatureResponse.signedMessage;
      } else {
          // Assume it's a buffer or byte array
          signedMessage = new TextDecoder().decode(signatureResponse.signedMessage as Uint8Array);
      }
  }
  
  if (!signedMessage) {
      throw new Error("Failed to extract signed message");
  }

  const signatureBytes = new TextEncoder().encode(signedMessage);
  const hashBuffer = await crypto.subtle.digest('SHA-256', signatureBytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const viewingKeyHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return viewingKeyHex;
};
