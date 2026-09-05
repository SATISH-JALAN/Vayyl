import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

import {
  DEFAULT_MAX_STALENESS,
  NoPriceError,
  OracleAdapter,
  StaleOracleError,
} from './adapter.js';

dotenv.config();

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const ORACLE_CONTRACT = process.env.ORACLE_CONTRACT;
const MAX_STALENESS = process.env.MAX_ORACLE_AGE
  ? parseInt(process.env.MAX_ORACLE_AGE, 10)
  : DEFAULT_MAX_STALENESS;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;

async function main() {
  console.log('Starting Vayyl Oracle Adapter...');

  // Refuse to start without a configured oracle, rather than defaulting to the
  // placeholder 'CD...' the previous version shipped with. A service that runs
  // and answers every request with an error is harder to diagnose than one that
  // will not start.
  if (!ORACLE_CONTRACT) {
    console.error('Error: ORACLE_CONTRACT environment variable is required');
    process.exit(1);
  }

  console.log(`Oracle: ${ORACLE_CONTRACT}`);
  console.log(`Staleness limit: ${MAX_STALENESS}s`);

  const adapter = new OracleAdapter(RPC_URL, ORACLE_CONTRACT, MAX_STALENESS);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', oracle: ORACLE_CONTRACT, maxStalenessSeconds: MAX_STALENESS });
  });

  app.get('/price/:asset', async (req, res) => {
    const asset = req.params.asset;
    try {
      const reading = await adapter.getAssetPrice(asset);
      res.json({
        asset: reading.asset,
        // As a STRING. `price` is an i128 of stroops, and JSON numbers are
        // doubles -- serialising it as a number would silently round any value
        // above 2^53 on its way to the client.
        price: reading.price.toString(),
        timestamp: reading.timestamp,
        ageSeconds: reading.ageSeconds,
      });
    } catch (err) {
      // There is deliberately NO fallback price here.
      //
      // The previous version answered every failure with `price: 2000` and a
      // fresh timestamp, in the same shape as a real reading. A fabricated
      // price served as an oracle response is worse than an outage, because an
      // outage is visible and this was not: a position could be opened,
      // attested and liquidated against a number nobody published.
      if (err instanceof StaleOracleError) {
        return res.status(503).json({
          error: 'stale_price',
          message: err.message,
          ageSeconds: err.ageSeconds,
          maxStalenessSeconds: err.maxStaleness,
        });
      }
      if (err instanceof NoPriceError) {
        return res.status(404).json({ error: 'no_price', message: err.message });
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`Price lookup failed for ${asset}: ${message}`);
      return res.status(502).json({ error: 'oracle_unreachable', message });
    }
  });

  app.listen(PORT, () => {
    console.log(`Oracle Adapter API server listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
