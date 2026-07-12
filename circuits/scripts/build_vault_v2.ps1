$ErrorActionPreference = "Stop"

$circuitsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildRoot = Join-Path $circuitsRoot "build\v2"
$ptauRoot = Join-Path $circuitsRoot "ptau"
$ptauFinal = Join-Path $ptauRoot "pot16_final.ptau"

function Invoke-Checked {
    param([Parameter(Mandatory = $true)][scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE"
    }
}

Push-Location $circuitsRoot
try {
    New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
    foreach ($dir in @("r1cs", "wasm", "zkey", "vkey")) {
        New-Item -ItemType Directory -Force -Path (Join-Path $buildRoot $dir) | Out-Null
    }
    New-Item -ItemType Directory -Force -Path $ptauRoot | Out-Null

    if (-not (Test-Path $ptauFinal)) {
        $ptau0 = Join-Path $ptauRoot "pot16_0000.ptau"
        $ptau1 = Join-Path $ptauRoot "pot16_0001.ptau"
        $entropy = [Convert]::ToHexString(
            [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
        )
        Invoke-Checked { pnpm exec snarkjs powersoftau new bn128 16 $ptau0 }
        Invoke-Checked {
            pnpm exec snarkjs powersoftau contribute $ptau0 $ptau1 `
                --name="Vayyl Testnet V2" -e=$entropy
        }
        $entropy = $null
        Invoke-Checked { pnpm exec snarkjs powersoftau prepare phase2 $ptau1 $ptauFinal }
        Remove-Item -LiteralPath $ptau0, $ptau1 -Force
    }

    foreach ($circuit in @("deposit_v2", "withdraw_v2")) {
        Invoke-Checked {
            circom "$circuit.circom" --r1cs --wasm --sym -o $buildRoot `
                -l (Join-Path $circuitsRoot "node_modules")
        }

        Move-Item -Force -LiteralPath (Join-Path $buildRoot "$circuit.r1cs") `
            -Destination (Join-Path $buildRoot "r1cs\$circuit.r1cs")
        Move-Item -Force -LiteralPath (Join-Path $buildRoot "${circuit}_js\$circuit.wasm") `
            -Destination (Join-Path $buildRoot "wasm\$circuit.wasm")

        $zkey0 = Join-Path $buildRoot "zkey\${circuit}_0000.zkey"
        $zkeyFinal = Join-Path $buildRoot "zkey\${circuit}_final.zkey"
        $entropy = [Convert]::ToHexString(
            [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
        )
        Invoke-Checked {
            pnpm exec snarkjs groth16 setup `
                (Join-Path $buildRoot "r1cs\$circuit.r1cs") $ptauFinal $zkey0
        }
        Invoke-Checked {
            pnpm exec snarkjs zkey contribute $zkey0 $zkeyFinal `
                --name="Vayyl Testnet V2" -e=$entropy
        }
        $entropy = $null

        $vkey = Join-Path $buildRoot "vkey\${circuit}_vkey.json"
        $stellarVkey = Join-Path $buildRoot "vkey\${circuit}_stellar_vkey.json"
        Invoke-Checked { pnpm exec snarkjs zkey export verificationkey $zkeyFinal $vkey }
        $formatted = pnpm exec node scripts\format_stellar_vk.js $vkey
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to format $circuit verification key"
        }
        Set-Content -LiteralPath $stellarVkey -Value $formatted -Encoding utf8

        Remove-Item -LiteralPath $zkey0 -Force
        Remove-Item -LiteralPath (Join-Path $buildRoot "${circuit}.sym") -Force
        Remove-Item -LiteralPath (Join-Path $buildRoot "${circuit}_js") -Recurse -Force
    }
}
finally {
    Pop-Location
}

Write-Host "Vault V2 testnet proving artifacts are ready under circuits/build/v2."
