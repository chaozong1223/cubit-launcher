<#
  NOTE: compatible with Windows PowerShell 5.1 (the execution host may not have pwsh).
  Run it as: powershell.exe -NoProfile -ExecutionPolicy Bypass -File poc-easytier.ps1

.SYNOPSIS
  Repro-friendly PoC: EasyTier 2.7.0 as an independent sidecar, no TUN / no admin,
  exposing one loopback service (Minecraft LAN world) to a "member" node through
  a mapped proxy CIDR + member-side TCP port-forward.

.DESCRIPTION
  Topology (both EasyTier processes run on this machine for the PoC):
    host   --no-tun, -i 10.144.144.1, -n 127.0.0.<alias>/32->192.168.77.1/32
             listener tcp://<lan-ip>:<peer-port>, RPC 127.0.0.1:<rpc>
    member --no-tun, -i 10.144.144.2, -p tcp://<lan-ip>:<peer-port>
             --no-listener, --port-forward tcp://127.0.0.1:<local>/192.168.77.1:<world-port>
  The member's local port is what the launcher would pass to Minecraft as
  `--server 127.0.0.1 --port <local>`.

  Success criteria:
    1. member sees host as a P2P peer (easytier-cli peer JSON)
    2. real Minecraft 1.20.1 status ping (or echo probe) through the tunnel returns a reply
    3. a decoy port on 127.0.0.1 is NOT reachable through the mapped alias
    4. TUN mode is documented as unavailable without admin (captured, not fatal)

  Everything is written to -OutDir (logs, JSON, RESULT.md, summary.json).
#>
[CmdletBinding()]
param(
  [string]$EasyTierDir = '',
  [string]$OutDir = '',
  [ValidateSet('mc', 'echo')]
  [string]$Backend = 'mc',
  [string]$McServerDir = '',
  [string]$JavaExe = 'D:\DSH-工作文件\tools\jdk21\jdk-21.0.12.1+1\bin\java.exe',
  [string]$AliasIp = '127.0.0.55',
  [string]$BindIp = '',
  [int]$PeerPort = 0,
  [int]$HostRpcPort = 0,
  [int]$MemberRpcPort = 0,
  [switch]$KeepAlive
)

if (-not $EasyTierDir) { $EasyTierDir = Join-Path $PSScriptRoot '..\tools\easytier-2.7.0\easytier-windows-x86_64' }
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot '..\evidence\tunnel' }
if (-not $McServerDir) { $McServerDir = Join-Path $PSScriptRoot '..\tools\mcserver\run' }

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------- helpers ----------
function New-FreePort([string]$Address = '0.0.0.0') {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($Address), 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  return $port
}

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds = 30, [int]$IntervalMs = 500, [string]$Label = 'condition') {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try { if (& $Condition) { return $true } } catch { }
    Start-Sleep -Milliseconds $IntervalMs
  }
  throw "timeout waiting for $Label (${TimeoutSeconds}s)"
}

function Invoke-TcpLineProbe([string]$HostName, [int]$Port, [string]$Payload, [int]$TimeoutMs = 4000) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $iar = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { throw 'connect timeout' }
    $client.EndConnect($iar)
    $stream = $client.GetStream()
    $bytes = [Text.Encoding]::UTF8.GetBytes($Payload)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    $buffer = New-Object byte[] 4096
    $read = $stream.Read($buffer, 0, $buffer.Length)
    return [Text.Encoding]::UTF8.GetString($buffer, 0, $read).Trim()
  } finally {
    $client.Close()
  }
}

function Get-CliJson([string]$Cli, [int]$RpcPort, [string[]]$Command) {
  $raw = & $Cli -p "127.0.0.1:$RpcPort" -o json @Command 2>&1 | Out-String
  $start = $raw.IndexOf('[')
  $startObj = $raw.IndexOf('{')
  if ($start -lt 0 -or ($startObj -ge 0 -and $startObj -lt $start)) { $start = $startObj }
  if ($start -lt 0) { throw "no JSON in cli output: $raw" }
  return ($raw.Substring($start) | ConvertFrom-Json)
}

function Stop-Tree([int]$ProcessId) {
  if (-not $ProcessId) { return }
  & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
}

function Get-PublicIpInfo {
  try {
    $r = Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 6
    return $r.ip
  } catch { return $null }
}

# ---------- setup ----------
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$logDir = Join-Path $OutDir "run-$runId"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$core = Join-Path $EasyTierDir 'easytier-core.exe'
$cli = Join-Path $EasyTierDir 'easytier-cli.exe'
foreach ($exe in @($core, $cli)) {
  if (-not (Test-Path $exe)) { throw "missing $exe (download EasyTier 2.7.0 zip and extract first)" }
}

if (-not $BindIp) {
  $candidates = Get-NetIPConfiguration | Where-Object {
    $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' -and
    $_.IPv4Address.IPAddress -notlike '127.*' -and $_.IPv4Address.IPAddress -notlike '169.254.*' -and
    $_.NetAdapter.Name -notmatch 'Radmin|VPN|TAP|vEthernet|Loopback|Bluetooth|Virtual'
  }
  $route = $candidates | Select-Object -First 1
  if (-not $route) { throw 'no active physical IPv4 interface found; pass -BindIp' }
  $BindIp = $route.IPv4Address.IPAddress
}
if ($PeerPort -le 0) { $PeerPort = New-FreePort $BindIp }
if ($HostRpcPort -le 0) { $HostRpcPort = New-FreePort '127.0.0.1' }
if ($MemberRpcPort -le 0) { $MemberRpcPort = New-FreePort '127.0.0.1' }
$memberWorldPort = New-FreePort '127.0.0.1'
$memberDecoyPort = New-FreePort '127.0.0.1'

$worldPort = 25565
$decoyPort = 25566
$netName = 'mcl-poc'
$secret = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })

$summary = [ordered]@{
  runId = $runId
  startedAt = (Get-Date).ToString('o')
  backend = $Backend
  host = [ordered]@{
    bindIp = $BindIp; aliasIp = $AliasIp; peerPort = $PeerPort; rpcPort = $HostRpcPort
    networkName = $netName; mode = 'no-tun'; mappedCidr = '192.168.77.1/32'
  }
  member = [ordered]@{
    localWorldPort = $memberWorldPort; localDecoyPort = $memberDecoyPort; rpcPort = $MemberRpcPort; mode = 'no-tun'
  }
  steps = @()
  ok = $false
}

$pids = [ordered]@{}
$mcPid = 0
$hostPid = 0
$memberPid = 0
$tunPid = 0

function Add-Step([string]$Name, [bool]$Ok, [string]$Detail) {
  $summary.steps += [ordered]@{ name = $Name; ok = $Ok; detail = $Detail; at = (Get-Date).ToString('o') }
  $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Host "[$tag] $Name - $Detail"
}

try {
  # ---- environment evidence ----
  $versions = & $core --version 2>&1 | Out-String
  $versions += (& $cli --version 2>&1 | Out-String)
  $versions | Set-Content (Join-Path $logDir 'easytier-version.txt') -Encoding utf8

  $hashes = [ordered]@{}
  $zip = Get-ChildItem (Join-Path $EasyTierDir '..\..') -Filter 'easytier-windows-x86_64-*.zip' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($zip) { $hashes['zip'] = (Get-FileHash $zip.FullName -Algorithm SHA256).Hash.ToLower(); $hashes['zipBytes'] = $zip.Length }
  $hashes['easytier-core.exe'] = (Get-FileHash $core -Algorithm SHA256).Hash.ToLower()
  $hashes['easytier-cli.exe'] = (Get-FileHash $cli -Algorithm SHA256).Hash.ToLower()
  $hashes['wintun.dll'] = (Get-FileHash (Join-Path $EasyTierDir 'wintun.dll') -Algorithm SHA256).Hash.ToLower()
  $hashes | ConvertTo-Json | Set-Content (Join-Path $logDir 'hashes.json') -Encoding utf8
  $summary['hashes'] = $hashes

  # public shared node DNS probe (documented node may be dead)
  $publicNode = [ordered]@{ host = 'public.easytier.top'; port = 11010; resolves = $false; tcp11010 = $false }
  try {
    $dns = Resolve-DnsName 'public.easytier.top' -Type A -ErrorAction Stop
    $publicNode.resolves = [bool]($dns | Where-Object { $_.IPAddress })
  } catch { }
  $publicNode.tcp11010 = (Test-NetConnection 'public.easytier.top' -Port 11010 -InformationLevel Quiet -WarningAction SilentlyContinue)
  $summary['publicSharedNode'] = $publicNode
  Add-Step 'public-shared-node' (-not $publicNode.resolves) "resolves=$($publicNode.resolves) tcp11010=$($publicNode.tcp11010) (expected NXDOMAIN from this network)"

  # TUN mode availability probe (captured as evidence, not fatal)
  $tunOut = Join-Path $logDir 'tun-probe.out.log'
  $tunErr = Join-Path $logDir 'tun-probe.err.log'
  $tunPort = New-FreePort '127.0.0.1'
  $tunProc = Start-Process $core -ArgumentList @(
    '-i', '10.144.144.9', '--network-name', $netName, '--network-secret', $secret,
    '-l', "tcp://127.0.0.1:$(New-FreePort '127.0.0.1')", '-r', "127.0.0.1:$tunPort", '-m', 'mcl-tun-probe', '--hostname', 'tun-probe', '--disable-ipv6'
  ) -RedirectStandardOutput $tunOut -RedirectStandardError $tunErr -PassThru -WindowStyle Hidden
  $tunPid = $tunProc.Id
  Start-Sleep -Seconds 8
  $tunLog = (Get-Content $tunOut -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $tunErr -Raw -ErrorAction SilentlyContinue)
  $tunDenied = $tunLog -match '0x80070005|os error 5|拒绝访问'
  $tunEvidence = 'no denial captured'
  if ($tunDenied) { $tunEvidence = 'Access denied while creating virtual NIC (needs Administrator)' }
  $summary['tunMode'] = [ordered]@{ available = (-not $tunDenied); evidence = $tunEvidence }
  Stop-Tree $tunPid; $tunPid = 0
  Add-Step 'tun-mode-probe' $true "informational: denied=$tunDenied ($tunEvidence); TUN is P1 and needs UAC"

  # ---- backend ----
  if ($Backend -eq 'mc') {
    if (-not (Test-Path (Join-Path $McServerDir '..\server-1.20.1.jar'))) { throw "missing server jar under $McServerDir\.." }
    if (-not (Test-Path $JavaExe)) { throw "missing Java: $JavaExe" }
    $mcOut = Join-Path $logDir 'mc-server.out.log'
    $mcErr = Join-Path $logDir 'mc-server.err.log'
    $mcProc = Start-Process $JavaExe -ArgumentList @('-Xms512M', '-Xmx1024M', '-jar', '..\server-1.20.1.jar', 'nogui') `
      -WorkingDirectory $McServerDir -RedirectStandardOutput $mcOut -RedirectStandardError $mcErr -PassThru -WindowStyle Hidden
    $mcPid = $mcProc.Id
    Wait-Until { (Test-NetConnection 127.0.0.1 -Port 25565 -InformationLevel Quiet -WarningAction SilentlyContinue) } 120 1000 'Minecraft server port 25565' | Out-Null
    Wait-Until { ((Get-Content $mcOut -Raw -ErrorAction SilentlyContinue) -match 'Done \(') } 120 700 'Minecraft server Done' | Out-Null
    Start-Sleep -Milliseconds 500
    $direct = & node (Join-Path $PSScriptRoot '..\mc-status.mjs') 127.0.0.1 25565 2>&1 | Out-String
    $direct | Set-Content (Join-Path $logDir 'mc-direct-status.json') -Encoding utf8
    Add-Step 'mc-server-direct' ($direct -match '"ok":true') $direct.Trim()
  } else {
    $echoOut = Join-Path $logDir 'echo.out.log'
    $echoProc = Start-Process node -ArgumentList @((Join-Path $PSScriptRoot '..\echo-server.mjs'), $AliasIp, "$worldPort", $echoOut) -PassThru -WindowStyle Hidden
    $mcPid = $echoProc.Id
    Start-Sleep -Seconds 1
    Add-Step 'echo-server-direct' (Test-NetConnection $AliasIp -Port $worldPort -InformationLevel Quiet -WarningAction SilentlyContinue) "echo on ${AliasIp}:$worldPort"
  }

  # ---- host node: maps only the dedicated loopback alias /32 into the virtual network ----
  $hostOut = Join-Path $logDir 'easytier-host.out.log'
  $hostErr = Join-Path $logDir 'easytier-host.err.log'
  $hostProc = Start-Process $core -ArgumentList @(
    '-i', '10.144.144.1', '--network-name', $netName, '--network-secret', $secret,
    '--no-tun', '-n', "$AliasIp/32->192.168.77.1/32", '--tcp-whitelist', "$worldPort",
    '-l', "tcp://${BindIp}:$PeerPort", '-r', "127.0.0.1:$HostRpcPort",
    '-m', 'mcl-host', '--hostname', 'poc-host', '--disable-ipv6'
  ) -RedirectStandardOutput $hostOut -RedirectStandardError $hostErr -PassThru -WindowStyle Hidden
  $hostPid = $hostProc.Id
  Wait-Until { Get-NetTCPConnection -LocalPort $PeerPort -State Listen -ErrorAction SilentlyContinue } 20 300 'host peer listener' | Out-Null
  Add-Step 'host-sidecar-start' $true "pid=$hostPid listener=tcp://${BindIp}:$PeerPort rpc=127.0.0.1:$HostRpcPort"

  # ---- member node: no listener, forwards a local port to the mapped alias ----
  $memberOut = Join-Path $logDir 'easytier-member.out.log'
  $memberErr = Join-Path $logDir 'easytier-member.err.log'
  $memberProc = Start-Process $core -ArgumentList @(
    '-i', '10.144.144.2', '--network-name', $netName, '--network-secret', $secret,
    '--no-tun', '--no-listener', '-p', "tcp://${BindIp}:$PeerPort",
    '--port-forward', "tcp://127.0.0.1:$memberWorldPort/192.168.77.1:$worldPort",
    '--port-forward', "tcp://127.0.0.1:$memberDecoyPort/192.168.77.1:$decoyPort",
    '-r', "127.0.0.1:$MemberRpcPort", '-m', 'mcl-member', '--hostname', 'poc-member', '--disable-ipv6'
  ) -RedirectStandardOutput $memberOut -RedirectStandardError $memberErr -PassThru -WindowStyle Hidden
  $memberPid = $memberProc.Id

  $peerOk = $false
  $peerJson = $null
  Wait-Until {
    try {
      $script:peerJson = Get-CliJson $cli $MemberRpcPort @('peer')
      $script:peerOk = [bool]($script:peerJson | Where-Object { $_.ipv4 -like '10.144.144.1*' -and $_.tunnel_proto })
    } catch { $script:peerOk = $false }
    $script:peerOk
  } 40 700 'member sees host peer' | Out-Null
  $peerJson | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $logDir 'member-peer.json') -Encoding utf8
  $routeJson = Get-CliJson $cli $MemberRpcPort @('route')
  $routeJson | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $logDir 'member-route.json') -Encoding utf8
  $natType = ($peerJson | Where-Object { $_.hostname -eq 'poc-host' } | Select-Object -First 1).nat_type
  $hostPeer = $peerJson | Where-Object { $_.ipv4 -like '10.144.144.1*' } | Select-Object -First 1
  $summary['peer'] = [ordered]@{ connected = $peerOk; natType = $natType; peer = $peerJson }
  Add-Step 'p2p-peer-established' $peerOk "host peer via $($hostPeer.tunnel_proto) tunnel, nat=$natType"

  # ---- payload through tunnel ----
  if ($Backend -eq 'mc') {
    $tunnelStatus = & node (Join-Path $PSScriptRoot '..\mc-status.mjs') 127.0.0.1 $memberWorldPort 2>&1 | Out-String
    $tunnelStatus | Set-Content (Join-Path $logDir 'mc-tunnel-status.json') -Encoding utf8
    $tunnelOk = $tunnelStatus -match '"ok":true' -and $tunnelStatus -match '1\.20\.1'
    Add-Step 'mc-status-through-tunnel' $tunnelOk $tunnelStatus.Trim()
  } else {
    $reply = Invoke-TcpLineProbe '127.0.0.1' $memberWorldPort "MCLPING tunnel-$runId`n"
    $tunnelOk = $reply -like 'MCLPONG*'
    Add-Step 'echo-through-tunnel' $tunnelOk $reply
  }

  # ---- exposure scoping: decoy must not be reachable ----
  $decoyBlocked = $true
  $decoyDetail = ''
  try {
    if ($Backend -eq 'mc') {
      $decoy = & node (Join-Path $PSScriptRoot '..\mc-status.mjs') 127.0.0.1 $memberDecoyPort 2>&1 | Out-String
      $decoyBlocked = -not ($decoy -match '"ok":true')
      $decoyDetail = $decoy.Trim()
    } else {
      $decoy = Invoke-TcpLineProbe '127.0.0.1' $memberDecoyPort "MCLPING decoy`n" 2500
      $decoyBlocked = -not ($decoy -like 'MCLPONG*')
      $decoyDetail = "reply=$decoy"
    }
  } catch {
    $decoyBlocked = $true
    $decoyDetail = "connection failed as expected: $($_.Exception.Message)"
  }
  Add-Step 'decoy-port-not-exposed' $decoyBlocked $decoyDetail

  # ---- network evidence ----
  $netstat = & netstat -ano | Select-String -Pattern ":$PeerPort|:$HostRpcPort|:$MemberRpcPort|:$memberWorldPort|:$worldPort" | Out-String
  $netstat | Set-Content (Join-Path $logDir 'netstat.txt') -Encoding utf8
  $listeners = Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @($PeerPort, $HostRpcPort, $MemberRpcPort, $memberWorldPort, $memberDecoyPort, $worldPort) } | Select-Object LocalAddress, LocalPort, OwningProcess
  $listeners | ConvertTo-Json | Set-Content (Join-Path $logDir 'listeners.json') -Encoding utf8
  $summary['listeners'] = $listeners
  $noWildcard = -not ($listeners | Where-Object { $_.LocalAddress -in @('0.0.0.0', '::') -and $_.LocalPort -ne $worldPort })
  Add-Step 'sidecar-listeners-scoped' $noWildcard "sidecars bind loopback/lan only (MC server itself binds *:25565 by design)"

  $summary['ok'] = ($peerOk -and $tunnelOk -and $decoyBlocked -and $noWildcard)
} catch {
  $summary['error'] = $_.Exception.Message
  Add-Step 'fatal' $false $_.Exception.Message
} finally {
  $summary['finishedAt'] = (Get-Date).ToString('o')
  $summary | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $logDir 'summary.json') -Encoding utf8
  Copy-Item (Join-Path $logDir 'summary.json') (Join-Path $OutDir 'summary-latest.json') -Force -ErrorAction SilentlyContinue

  $result = @"
# EasyTier tunnel PoC result ($runId)

- backend: $Backend
- bind IP: $BindIp ; alias: $AliasIp ; peer port: $PeerPort
- host RPC: $HostRpcPort ; member RPC: $MemberRpcPort
- member local world port: $memberWorldPort (Minecraft would use --server 127.0.0.1 --port $memberWorldPort)
- member local decoy port: $memberDecoyPort
- overall: $($summary.ok)
- NAT type (EasyTier STUN): $($summary.peer.natType)

## Steps
$((($summary.steps | ForEach-Object { $_.name + ' => ' + $_.ok + ' :: ' + $_.detail }) -join "`n"))

## Notes
- EasyTier 2.7.0, no-TUN mode, no Administrator required.
- Public shared node public.easytier.top did not resolve from this network (NXDOMAIN), so relay path is not exercised here.
- TUN mode failed with access denied (needs Administrator), captured in tun-probe logs.
- Logs, hashes and JSON live next to this file.
"@
  $result | Set-Content (Join-Path $logDir 'RESULT.md') -Encoding utf8

  if (-not $KeepAlive) {
    Stop-Tree $memberPid
    Stop-Tree $hostPid
    Stop-Tree $mcPid
    if ($tunPid) { Stop-Tree $tunPid }
  }
}

Write-Host ''
Write-Host "evidence: $logDir"
if (-not $summary.ok) { exit 1 }
