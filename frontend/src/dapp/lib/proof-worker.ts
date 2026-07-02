import { computeCommitment } from './crypto';
import * as snarkjs from 'snarkjs';

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, id } = e.data;

  try {
    let result;
    
    switch (type) {
      case 'PROVE_DEPOSIT':
        {
          const pubKey = '12345'; // Derived from viewing key in real usage
          const blindness = payload.blindness || '99999';
          const commitment = await computeCommitment(payload.amount.toString(), blindness, pubKey);
          
          const input = {
            amount: payload.amount.toString(),
            commitment: BigInt(commitment).toString(),
            asp_root: "0",
            pubX: pubKey,
            pubY: "0",
            blindness: blindness,
            asp_pathElements: Array(20).fill("0"),
            asp_pathIndices: Array(20).fill(0)
          };
          
          const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            "/circuits/deposit.wasm",
            "/circuits/deposit_final.zkey"
          );
          
          result = { proof, publicSignals };
        }
        break;
      
      case 'PROVE_TRANSFER':
        {
          const input = payload.circuitInput; // Should be constructed in main thread and passed
          const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            "/circuits/transfer.wasm",
            "/circuits/transfer_final.zkey"
          );
          result = { proof, publicSignals };
        }
        break;
        
      case 'PROVE_WITHDRAW':
        {
          const input = payload.circuitInput;
          const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            "/circuits/withdraw.wasm",
            "/circuits/withdraw_final.zkey"
          );
          result = { proof, publicSignals };
        }
        break;
        
      case 'PROVE_POSITION_OPEN':
        await new Promise(resolve => setTimeout(resolve, 2500));
        result = { proof: "mock_position_open_proof", publicSignals: [payload.size, payload.direction] };
        break;
        
      case 'PROVE_POSITION_CLOSE':
        await new Promise(resolve => setTimeout(resolve, 2500));
        result = { proof: "mock_position_close_proof", publicSignals: [payload.id] };
        break;
        
      default:
        throw new Error(`Unknown circuit type: ${type}`);
    }

    self.postMessage({ id, status: 'success', result });
  } catch (error: any) {
    self.postMessage({ id, status: 'error', error: error.message });
  }
};
