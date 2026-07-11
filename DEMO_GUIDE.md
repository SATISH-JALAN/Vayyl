# Vayyl Vault v1 — Mainnet Demo Guide

## One-time preparation

1. Start the local Postgres, Mainnet indexer, and production Next server.
2. In Freighter, select **Mainnet** and connect the funded demo account.
3. Open `http://localhost:3000/app?view=pool`, click **Unlock Workspace**, and approve the fixed Vayyl authentication message.
4. Copy the displayed ASP leaf and enroll it once with `scripts/asp_insert.js` before depositing.
5. Rehearse with a separate small note, then clear only the local activity needed for a clean recording. Never clear an unspent note.

## Recording sequence (90–120 seconds)

1. Open `http://localhost:3000/app` and show **Vault v1 is live on Mainnet** plus **Indexer online**.
2. Connect Freighter. Keep the seed phrase, wallet settings, console, and raw witness data off-screen.
3. Open **XLM Vault** and select **Shield**.
4. Enter `0.10 XLM`, generate the client-side proof, approve the Freighter transaction, and wait for confirmation.
5. Return to **Dashboard**. Show the `0.10 XLM` shielded note and open its public Stellar Expert transaction link.
6. Return to **XLM Vault**, select **Unshield**, enter the same `0.10 XLM`, and use the connected demo address as destination.
7. Generate the withdrawal proof, approve the transaction, and wait for confirmation.
8. Show the withdrawal in **Recent activity**, open its Stellar Expert link, and show that the note is no longer active.
9. End on **Mainnet evidence**. State: “Vault v1 supports proof-backed XLM shielding and whole-note withdrawal. Other protocol modules remain disabled pending audit.”

## Local startup after a reboot

```powershell
docker compose -f backend\docker-compose.vault.yml up -d

$env:DATABASE_URL='postgresql://postgres:vault_demo@127.0.0.1:5433/vayyl_vault'
$env:RPC_URL='https://stellar.api.onfinality.io/public'
$env:POOL_ADDRESS='CB2NWPFWW5YLD6UYWR4RFERECSMBF6SB62P7RRP2LF2P2EMDSDLAZ3OW'
$env:PORT='3001'
pnpm --dir backend/indexer start

pnpm --dir frontend build
pnpm --dir frontend start
```

Use the production server for recording. It avoids development-only hot-reload traffic and console noise.
