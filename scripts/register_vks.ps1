# DEPRECATED — do not use.
#
# This PowerShell version encoded `circuit_id` as a bare integer (`--circuit_id 0`),
# but the on-chain ABI is `set_vk(circuit_id: CircuitId, vk)` — the CLI needs the
# enum-JSON form `{"Deposit":[]}`. It also lacked the gamma != delta safety guard
# (Veil Cash / FoomCash bug) and used a mismatched circuit name.
#
# The canonical, correct path is scripts/register_vks.js (enum encoding + gamma
# guard + dynamic verifier-id resolution). Delegating to it here.

Write-Host "register_vks.ps1 is deprecated; delegating to scripts/register_vks.js" -ForegroundColor Yellow
node scripts/register_vks.js
