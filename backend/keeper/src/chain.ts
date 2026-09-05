// ============================================================
// Keeper <-> chain
// ============================================================
// Reads are simulations; writes are signed and submitted. Replaces shelling out
// to `stellar contract invoke` once per position per tick, which needed the CLI
// on PATH, a configured keypair alias, and a process spawn per read.

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

import type { EngineView } from './decide.js';

const VIEW_SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const bytesN = (hex: string) => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return xdr.ScVal.scvBytes(Buffer.from(clean.padStart(64, '0'), 'hex'));
};

export class Chain {
  private readonly server: rpc.Server;
  private readonly engineId: string;
  private readonly keypair: Keypair;
  private readonly networkPassphrase: string;

  constructor(
    rpcUrl: string,
    engineId: string,
    secret: string,
    networkPassphrase = Networks.TESTNET,
  ) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: true });
    this.engineId = engineId;
    this.keypair = Keypair.fromSecret(secret);
    this.networkPassphrase = networkPassphrase;
  }

  get address(): string {
    return this.keypair.publicKey();
  }

  private async read(method: string, args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(VIEW_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(new Contract(this.engineId).call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim) || !sim.result) {
      throw new Error(
        rpc.Api.isSimulationError(sim) ? sim.error : `${method} returned no result`,
      );
    }
    return scValToNative(sim.result.retval);
  }

  private async send(method: string, args: xdr.ScVal[]): Promise<string> {
    const source = await this.server.getAccount(this.keypair.publicKey());
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(new Contract(this.engineId).call(method, ...args))
      .setTimeout(60)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(this.keypair);
    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === 'ERROR') {
      throw new Error(`${method} rejected: ${JSON.stringify(sent.errorResult)}`);
    }

    // Poll to completion rather than returning on submission. A keeper that
    // assumed success would go on to reveal against a claim that never landed.
    for (let i = 0; i < 30; i++) {
      const got = await this.server.getTransaction(sent.hash);
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
      if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`${method} failed on-chain: ${sent.hash}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${method} did not confirm within 30s: ${sent.hash}`);
  }

  /** Everything the decision needs about one position, in three reads. */
  async view(positionId: string): Promise<EngineView> {
    const [isStale, isLiquidated, secondsUntilStale, escrow] = await Promise.all([
      this.read('is_stale', [bytesN(positionId)]) as Promise<boolean>,
      this.read('is_liquidated', [bytesN(positionId)]) as Promise<boolean>,
      this.read('seconds_until_stale', [bytesN(positionId)]) as Promise<number | bigint>,
      this.read('escrow_of', [bytesN(positionId)]) as Promise<
        { keeper: string; initiated_at: number | bigint } | null
      >,
    ]);

    return {
      isStale,
      isLiquidated,
      secondsUntilStale: Number(secondsUntilStale),
      escrow: escrow
        ? { keeper: String(escrow.keeper), initiatedAt: Number(escrow.initiated_at) }
        : undefined,
    };
  }

  /**
   * The commitment for a secret, computed BY THE CONTRACT.
   *
   * Not reimplemented locally. Poseidon2 over BN254 with the field reduction the
   * contract applies is exactly the kind of thing two implementations get subtly
   * different, and the symptom would be a keeper that can claim positions and
   * never collect on them -- its reveal failing `BadSecret` every time.
   */
  async keeperCommitment(secretHex: string): Promise<string> {
    const raw = await this.read('keeper_commitment_for', [bytesN(secretHex)]);
    return Buffer.from(raw as Uint8Array).toString('hex');
  }

  async initiate(positionId: string, commitmentHex: string): Promise<string> {
    return this.send('initiate_liquidation', [
      new Address(this.keypair.publicKey()).toScVal(),
      bytesN(positionId),
      bytesN(commitmentHex),
    ]);
  }

  async revealAndSeize(positionId: string, secretHex: string): Promise<string> {
    return this.send('reveal_and_seize', [
      new Address(this.keypair.publicKey()).toScVal(),
      bytesN(positionId),
      bytesN(secretHex),
    ]);
  }

  async gracePeriod(): Promise<number> {
    return Number(await this.read('grace_period', []));
  }

  async bountyBps(): Promise<bigint> {
    return BigInt(String(await this.read('keeper_bounty_bps', [])));
  }
}

export { nativeToScVal };
