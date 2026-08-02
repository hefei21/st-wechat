[CmdletBinding()]
param(
    [switch]$SkipPreflight,
    [switch]$AllowDirty
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$artifactRoot = Join-Path $projectRoot '.artifacts'

Push-Location $projectRoot
try {
    if (-not $SkipPreflight) {
        & (Join-Path $PSScriptRoot 'preflight.ps1')
        if ($LASTEXITCODE -ne 0) {
            throw "Preflight failed with exit code $LASTEXITCODE"
        }
    }

    $statusLines = @(git -c core.quotepath=false status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to read Git workspace status.'
    }
    $isDirty = $statusLines.Count -gt 0
    if ($isDirty -and -not $AllowDirty) {
        throw 'The workspace is dirty. Create a traceable commit or pass -AllowDirty explicitly.'
    }

    $commit = (git rev-parse --short=12 HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $commit) {
        throw 'Unable to read the current Git commit.'
    }

    $version = (Get-Content -Raw -Encoding UTF8 (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
    $timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
    $dirtySuffix = if ($isDirty) { '-dirty' } else { '' }
    $baseName = "st-wechat-$version-$commit$dirtySuffix-$timestamp"
    $archivePath = Join-Path $artifactRoot "$baseName.zip"
    $checksumPath = "$archivePath.sha256"
    $stagingRoot = Join-Path $artifactRoot ".staging-$([guid]::NewGuid().ToString('N'))"
    $packageRoot = Join-Path $stagingRoot 'st-wechat'

    New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

    try {
        $files = @(
            'package.json',
            'package-lock.json',
            'config.yaml',
            'README.md',
            'CHANGELOG.md',
            'CONTRIBUTING.md',
            'SECURITY.md',
            'deploy/production/compose.yml',
            'deploy/test/compose.yml'
        )
        $directories = @(
            'src',
            'ui-extension',
            'docs'
        )

        foreach ($file in $files) {
            $source = Join-Path $projectRoot $file
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
                throw "Missing package file: $file"
            }
            $destination = Join-Path $packageRoot $file
            $destinationParent = Split-Path -Parent $destination
            New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination
        }

        foreach ($directory in $directories) {
            $source = Join-Path $projectRoot $directory
            if (-not (Test-Path -LiteralPath $source -PathType Container)) {
                throw "Missing package directory: $directory"
            }
            Copy-Item -LiteralPath $source -Destination $packageRoot -Recurse
        }

        $buildInfo = [ordered]@{
            name = 'st-wechat'
            version = $version
            commit = $commit
            dirty = $isDirty
            createdAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        }
        $buildInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot 'BUILD_INFO.json') -Encoding UTF8

        New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::Open(
            $archivePath,
            [IO.Compression.ZipArchiveMode]::Create
        )
        try {
            foreach ($packageFile in Get-ChildItem -LiteralPath $packageRoot -File -Recurse) {
                $entryName = $packageFile.FullName.Substring($stagingRoot.Length + 1).Replace('\', '/')
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive,
                    $packageFile.FullName,
                    $entryName,
                    [IO.Compression.CompressionLevel]::Optimal
                ) | Out-Null
            }
        }
        finally {
            $archive.Dispose()
        }

        $archiveEntries = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            $invalidEntry = $archiveEntries.Entries |
                Where-Object { $_.FullName.Contains('\') } |
                Select-Object -First 1
            if ($invalidEntry) {
                throw "Archive contains a non-portable path: $($invalidEntry.FullName)"
            }
        }
        finally {
            $archiveEntries.Dispose()
        }

        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
        "$hash  $([IO.Path]::GetFileName($archivePath))" |
            Set-Content -LiteralPath $checksumPath -Encoding ASCII
    }
    finally {
        $resolvedArtifactRoot = [IO.Path]::GetFullPath($artifactRoot)
        $resolvedStagingRoot = [IO.Path]::GetFullPath($stagingRoot)
        if ($resolvedStagingRoot.StartsWith($resolvedArtifactRoot + [IO.Path]::DirectorySeparatorChar) -and
            (Test-Path -LiteralPath $resolvedStagingRoot)) {
            Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force
        }
    }

    Write-Host ""
    Write-Host "Plugin package: $archivePath" -ForegroundColor Green
    Write-Host "Checksum file: $checksumPath" -ForegroundColor Green
    if ($isDirty) {
        Write-Warning 'This package was built from a dirty workspace. Use it for temporary testing only.'
    }
}
finally {
    Pop-Location
}
