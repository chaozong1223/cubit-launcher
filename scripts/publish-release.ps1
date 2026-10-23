# Publish the packaged zip to GitHub Releases.
#
# Requirements:
#   - $env:GH_TOKEN set to a PAT with `repo` scope (classic) or Contents:write (fine-grained)
#   - release\mc-launcher-<version>-win-x64.zip already built by the pack step
#
# Usage:
#   $env:GH_TOKEN = 'ghp_...'
#   pwsh -File scripts\publish-release.ps1 -Version 0.1.0
#
# The token is read from the environment and never written to disk.

param(
  [string]$Version = '0.1.0',
  [string]$Repo = 'chaozong1223/cubit-launcher',
  [string]$NotesFile = 'docs/release-0.1.0.md'
)

$ErrorActionPreference = 'Stop'

if (-not $env:GH_TOKEN) {
  throw 'GH_TOKEN is not set. Export a PAT with repo scope first.'
}

$zip = Join-Path $PSScriptRoot "..\release\mc-launcher-$Version-win-x64.zip"
if (-not (Test-Path $zip)) {
  throw "Missing package: $zip (run the pack step first)"
}
$zip = (Resolve-Path $zip).Path
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
Write-Host "package: $zip"
Write-Host "sha256 : $hash"

$headers = @{
  Authorization          = "token $env:GH_TOKEN"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = 'cubit-launcher-release'
  'X-GitHub-Api-Version' = '2022-11-28'
}

$notes = if (Test-Path (Join-Path $PSScriptRoot "..\$NotesFile")) {
  Get-Content (Join-Path $PSScriptRoot "..\$NotesFile") -Raw
} else {
  "Cubit Launcher $Version"
}
$notes = $notes + "`n`n---`n`nSHA-256 of the attached zip:``$hash``"

$body = @{
  tag_name   = "v$Version"
  name       = "Cubit Launcher $Version"
  body       = $notes
  draft      = $false
  prerelease = $false
} | ConvertTo-Json

Write-Host 'creating release...'
$release = Invoke-RestMethod -Method Post `
  -Uri "https://api.github.com/repos/$Repo/releases" `
  -Headers $headers -ContentType 'application/json' -Body $body

Write-Host "release id: $($release.id)"
$assetName = "mc-launcher-$Version-win-x64.zip"
$uploadUrl = "https://uploads.github.com/repos/$Repo/releases/$($release.id)/assets?name=$assetName"

Write-Host "uploading $([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB..."
$asset = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers `
  -ContentType 'application/zip' -InFile $zip -TimeoutSec 1800

Write-Host "uploaded: $($asset.browser_download_url)"
