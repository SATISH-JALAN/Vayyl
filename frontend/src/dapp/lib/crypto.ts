export function generateBlindness(): string {
  // Generate 32 bytes of random data for the blindness factor
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  
  // Convert to hex string (simplification for the UI demo)
  return Array.from(array)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function computeMockCommitment(amount: string, blindness: string, pubKey: string): string {
  // In a real implementation, this would use the Poseidon2 hash function
  // matching the Circom circuit and Soroban contract exactly.
  // For the UI demo, we return a mock hex string.
  return '0x' + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function computeMockNullifier(commitment: string, privKey: string): string {
  return '0x' + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('');
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
