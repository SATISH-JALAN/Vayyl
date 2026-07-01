$ErrorActionPreference = "Stop"

$NETWORK = "testnet"
$SOURCE = "deployer"
$VERIFIER_ID = "CAITE7BPXCMYW2I5GKJIV5PKYFNYUBZOJX2PS467EPXSTJO45YFQZIBQ"

$CIRCUITS = @{
    "Deposit" = @{ id = 0; file = "deposit" }
    "Transfer" = @{ id = 1; file = "transfer" }
    "Withdraw" = @{ id = 2; file = "withdraw" }
    "PositionOpen" = @{ id = 3; file = "position_open" }
    "PositionHealthAttestation" = @{ id = 4; file = "position_health" }
    "PositionClose" = @{ id = 5; file = "position_close" }
}

foreach ($name in $CIRCUITS.Keys) {
    $circuit = $CIRCUITS[$name]
    $id = $circuit.id
    $file = $circuit.file
    $vk_args = Get-Content "circuits\build\vkey\${file}_stellar_vkey.json" | Out-String

    Write-Host "Registering VK for $name (ID = $id)..."
    # Invoke stellar contract
    Invoke-Expression "stellar contract invoke --id $VERIFIER_ID --network $NETWORK --source $SOURCE -- set_vk --circuit_id $id $vk_args"
}

Write-Host "All VKs registered successfully!"
