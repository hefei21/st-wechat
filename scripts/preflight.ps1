[CmdletBinding()]
param(
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Invoke-NativeStep {
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [Parameter(Mandatory)]
        [scriptblock]$Command
    )

    Write-Host ""
    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

Push-Location $projectRoot
try {
    if ($Install) {
        Invoke-NativeStep 'Install locked dependencies' {
            npm.cmd ci --ignore-scripts --no-audit --no-fund
        }
    }

    Invoke-NativeStep 'JavaScript syntax check' {
        npm.cmd run check
    }

    Invoke-NativeStep 'Automated tests' {
        npm.cmd test
    }

    Invoke-NativeStep 'Git diff check' {
        git diff --check
    }

    Invoke-NativeStep 'Sensitive runtime file check' {
        $trackedFiles = @(git -c core.quotepath=false ls-files)
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }

        $forbiddenNames = @(
            '.env',
            '.wechat_creds.json',
            'qrcode.png'
        )

        $violations = @(
            $trackedFiles | Where-Object {
                $name = [IO.Path]::GetFileName($_)
                $forbiddenNames -contains $name -or $_ -like '.artifacts/*' -or $_ -like '.test-results/*'
            }
        )

        if ($violations.Count -gt 0) {
            Write-Error ("Forbidden files are tracked:`n" + ($violations -join "`n"))
            exit 1
        }
    }

    Write-Host ""
    Write-Host 'Preflight passed: syntax, tests, diff, and sensitive-file checks are clean.' -ForegroundColor Green
}
finally {
    Pop-Location
}
