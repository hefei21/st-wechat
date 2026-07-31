[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BaseUrl,
    [int]$TimeoutSeconds = 15,
    [int]$MaxAttempts = 20,
    [switch]$SkipLlm
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$resultRoot = Join-Path $projectRoot '.test-results'
$base = $BaseUrl.TrimEnd('/')
$statusUrl = "$base/api/plugins/st-wechat/status"
$llmUrl = "$base/api/plugins/st-wechat/test-llm"

Add-Type -AssemblyName System.Net.Http
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
$client.DefaultRequestHeaders.Accept.ParseAdd('application/json')
$client.DefaultRequestHeaders.UserAgent.ParseAdd('st-wechat-smoke-test/1.0')

function Invoke-JsonRequest {
    param(
        [Parameter(Mandatory)]
        [System.Net.Http.HttpMethod]$Method,
        [Parameter(Mandatory)]
        [string]$Url
    )

    $request = [System.Net.Http.HttpRequestMessage]::new($Method, $Url)
    if ($Method -eq [System.Net.Http.HttpMethod]::Post) {
        $request.Content = [System.Net.Http.StringContent]::new('{}', [Text.Encoding]::UTF8, 'application/json')
    }

    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "HTTP $([int]$response.StatusCode) $($response.ReasonPhrase)"
        }
        return $body | ConvertFrom-Json
    }
    finally {
        $request.Dispose()
        if ($null -ne $response) {
            $response.Dispose()
        }
    }
}

try {
    Write-Host "Waiting for test environment: $statusUrl" -ForegroundColor Cyan
    $status = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $status = Invoke-JsonRequest -Method ([System.Net.Http.HttpMethod]::Get) -Url $statusUrl
            break
        }
        catch {
            if ($attempt -eq $MaxAttempts) {
                throw
            }
            Write-Host "Attempt $attempt/$MaxAttempts is not ready; retrying in 5 seconds: $($_.Exception.Message)"
            Start-Sleep -Seconds 5
        }
    }

    $safeStatus = [ordered]@{
        state = $status.state
        running = [bool]$status.running
        loggedIn = [bool]$status.loggedIn
        characterCount = @($status.characters).Count
        provider = $status.provider
        model = $status.llm
    }

    $llmResult = $null
    if (-not $SkipLlm) {
        Write-Host "Checking LLM connection: $llmUrl" -ForegroundColor Cyan
        $llmResult = Invoke-JsonRequest -Method ([System.Net.Http.HttpMethod]::Post) -Url $llmUrl
    }

    $result = [ordered]@{
        checkedAt = (Get-Date).ToString('o')
        baseUrl = $base
        status = $safeStatus
        llmTest = $llmResult
        passed = ($null -ne $status) -and ($SkipLlm -or [bool]$llmResult.ok)
    }

    New-Item -ItemType Directory -Path $resultRoot -Force | Out-Null
    $resultPath = Join-Path $resultRoot "smoke-$((Get-Date).ToString('yyyyMMdd-HHmmss')).json"
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8

    Write-Host ""
    Write-Host "State: $($safeStatus.state); characters: $($safeStatus.characterCount); model: $($safeStatus.provider)/$($safeStatus.model)"
    if (-not $SkipLlm) {
        Write-Host "LLM: $($llmResult.ok)"
    }
    Write-Host "Sanitized result: $resultPath"

    if (-not $result.passed) {
        throw 'Smoke test did not pass.'
    }
    Write-Host 'Automated smoke test passed.' -ForegroundColor Green
}
finally {
    $client.Dispose()
    $handler.Dispose()
}
