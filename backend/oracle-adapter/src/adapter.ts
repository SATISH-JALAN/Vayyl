import * as StellarSdk from '@stellar/stellar-sdk';

/**
 * SEP-40 price adapter.
 *
 * Three things were wrong with the previous version, and they compounded:
 *
 *   1. It called `get_last_price()` -- a non-standard, argument-less method
 *      implemented only by a test stub. Against the real Reflector contract, or
 *      against the SEP-40 mock oracle in this repo, that call does not exist.
 *
 *   2. The staleness window was ONE YEAR (31,536,000 seconds), which is not a
 *      staleness check. Any price the feed had ever published passed it.
 *
 *   3. On ANY error the HTTP layer returned `price: 2000` with a fresh
 *      timestamp, formatted exactly like a real reading. A fabricated price
 *      served as an oracle response is worse than an outage: an outage is
 *      visible, and this was not. Nothing downstream could tell the difference.
 *
 * The rule here now is that this service either returns a real, fresh price or
 * it returns an error. There is no third option, because a position's solvency
 * is judged against whatever this says.
 */

/** Seconds. Matches `PositionManager::MAX_ORACLE_AGE`, deliberately. */
export const DEFAULT_MAX_STALENESS = 300;

export interface PriceReading {
  asset: string;
  /** Stroops of collateral per contract unit. BigInt: this is an i128 on-chain. */
  price: bigint;
  /** Seconds since the epoch, as the feed published it. */
  timestamp: number;
  /** How old the reading is, in seconds, at the moment it was read. */
  ageSeconds: number;
}

export class StaleOracleError extends Error {
  // Explicit fields rather than parameter properties: `node --test` runs these
  // in strip-only mode, which cannot erase `constructor(readonly x: T)`.
  readonly asset: string;
  readonly ageSeconds: number;
  readonly maxStaleness: number;

  constructor(asset: string, ageSeconds: number, maxStaleness: number) {
    super(
      `Price for ${asset} is ${ageSeconds}s old; the limit is ${maxStaleness}s. ` +
      'Refusing to serve it.',
    );
    this.asset = asset;
    this.ageSeconds = ageSeconds;
    this.maxStaleness = maxStaleness;
    this.name = 'StaleOracleError';
  }
}

export class NoPriceError extends Error {
  readonly asset: string;

  constructor(asset: string) {
    super(`The oracle has never published a price for ${asset}.`);
    this.asset = asset;
    this.name = 'NoPriceError';
  }
}

/**
 * Decide whether a reading may be used, given the clock.
 *
 * Split out as a pure function so the policy is testable without a network,
 * because the policy is the entire product of this service.
 */
export function evaluate(
  asset: string,
  raw: { price: bigint; timestamp: number } | null,
  nowSeconds: number,
  maxStaleness: number = DEFAULT_MAX_STALENESS,
): PriceReading {
  if (raw === null) {
    // Not "price zero". A caller that treats a missing price as zero computes a
    // zero notional, and a zero notional makes every position look healthy --
    // the quietest possible way to disable liquidation.
    throw new NoPriceError(asset);
  }
  if (raw.price <= 0n) {
    throw new NoPriceError(asset);
  }

  const age = nowSeconds - raw.timestamp;

  // A future-dated price reads as permanently fresh to every staleness
  // comparison downstream, so one such record would make positions
  // unliquidatable until the clock caught up. Rejected outright rather than
  // clamped: a feed publishing into the future is malfunctioning, and serving
  // its numbers anyway hides that.
  if (age < 0) {
    throw new StaleOracleError(asset, age, maxStaleness);
  }
  if (age > maxStaleness) {
    throw new StaleOracleError(asset, age, maxStaleness);
  }

  return { asset, price: raw.price, timestamp: raw.timestamp, ageSeconds: age };
}

/** How the adapter reaches the chain. Injected so the policy can be tested. */
export type PriceSource = (asset: string) => Promise<{ price: bigint; timestamp: number } | null>;

export class OracleAdapter {
  private readonly source: PriceSource;
  private readonly oracleContractId: string;
  private readonly maxStaleness: number;

  constructor(
    rpcUrl: string,
    oracleContractId: string,
    maxStaleness: number = DEFAULT_MAX_STALENESS,
    source?: PriceSource,
  ) {
    this.oracleContractId = oracleContractId;
    this.maxStaleness = maxStaleness;
    this.source = source ?? this.simulateLastPrice(rpcUrl);
  }

  /**
   * SEP-40 `lastprice(asset) -> Option<PriceData>`, read by simulation.
   *
   * `Asset` is an enum: `Other(Symbol)` for a synthetic ticker like "XLM",
   * `Stellar(Address)` for a SAC. The encoding must match the contract's
   * `#[contracttype]` exactly, because the price is stored UNDER this value as
   * a key -- a mis-encoded asset reads as "no price published" rather than as
   * an error, which is exactly the failure that is hardest to notice.
   */
  private simulateLastPrice(rpcUrl: string): PriceSource {
    const server = new StellarSdk.rpc.Server(rpcUrl, { allowHttp: true });
    return async (asset: string) => {
      const assetScVal = StellarSdk.xdr.ScVal.scvVec([
        StellarSdk.xdr.ScVal.scvSymbol('Other'),
        StellarSdk.xdr.ScVal.scvSymbol(asset),
      ]);

      const tx = new StellarSdk.TransactionBuilder(
        // A throwaway source: this is a read-only simulation and is never
        // submitted, so the account need not exist or hold anything.
        new StellarSdk.Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'),
        { fee: '100', networkPassphrase: StellarSdk.Networks.TESTNET },
      )
        .addOperation(new StellarSdk.Contract(this.oracleContractId).call('lastprice', assetScVal))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (StellarSdk.rpc.Api.isSimulationError(sim)) {
        throw new Error(`Oracle simulation failed: ${sim.error}`);
      }
      const retval = (sim as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      if (!retval) throw new Error('Oracle returned no value');

      const native = StellarSdk.scValToNative(retval);
      if (native === null || native === undefined) return null;

      // `scValToNative` gives i128 as a bigint. Never coerce through Number:
      // above 2^53 that loses precision silently, and a mis-read price is a
      // mis-priced position with no error anywhere.
      return {
        price: BigInt(native.price),
        timestamp: Number(native.timestamp),
      };
    };
  }

  async getAssetPrice(asset: string, nowSeconds?: number): Promise<PriceReading> {
    const raw = await this.source(asset);
    return evaluate(
      asset,
      raw,
      nowSeconds ?? Math.floor(Date.now() / 1000),
      this.maxStaleness,
    );
  }
}
