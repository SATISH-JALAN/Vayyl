import { computeMockCommitment } from './crypto';

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, id } = e.data;

  try {
    let result;
    
    switch (type) {
      case 'PROVE_DEPOSIT':
        // Mock heavy computation
        await new Promise(resolve => setTimeout(resolve, 2000));
        result = {
          proof: {
            pi_a: ["1", "2", "3"],
            pi_b: [["1", "2"], ["3", "4"], ["5", "6"]],
            pi_c: ["1", "2", "3"],
            protocol: "groth16"
          },
          publicSignals: [
            payload.amount,
            computeMockCommitment(payload.amount.toString(), 'mock_blindness', 'mock_pubkey'),
            'mock_asp_root'
          ]
        };
        break;
      
      case 'PROVE_TRANSFER':
        await new Promise(resolve => setTimeout(resolve, 2500));
        result = { proof: "mock_transfer_proof", publicSignals: [payload.amount, payload.recipient] };
        break;
        
      case 'PROVE_WITHDRAW':
        await new Promise(resolve => setTimeout(resolve, 2000));
        result = { proof: "mock_withdraw_proof", publicSignals: [payload.amount, payload.destination] };
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
