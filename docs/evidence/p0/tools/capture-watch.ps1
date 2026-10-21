# t34 acceptance evidence helper: capture the launcher window and the Minecraft
# window while `npm run e2e:install-launch` is running.
# Usage:
#   powershell -ExecutionPolicy Bypass -File capture-watch.ps1 -OutDir <dir> -TimeoutMinutes 20
# It only reads process/window state and writes PNGs + capture.log under OutDir.
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$TimeoutMinutes = 20,
  [string]$WorkspaceRoot = ""
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[WinCap]::SetProcessDPIAware() | Out-Null

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$logPath = Join-Path $OutDir 'capture.log'
function Log([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $message
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
}

if (-not $WorkspaceRoot -or $WorkspaceRoot -eq '') {
  $WorkspaceRoot = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) '.e2e'
}
Log "watching workspaces under $WorkspaceRoot"

function Get-NewestWorkspace {
  $dirs = Get-ChildItem -Path $WorkspaceRoot -Directory -Filter 'e2e-install-*' | Sort-Object LastWriteTime -Descending
  if ($dirs.Count -gt 0) { return $dirs[0].FullName }
  return $null
}

function Get-WindowHandle([string[]]$names) {
  foreach ($name in $names) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
    foreach ($p in $procs) {
      if ([WinCap]::IsWindowVisible($p.MainWindowHandle)) { return $p.MainWindowHandle }
    }
  }
  return [IntPtr]::Zero
}

function Capture-Window([IntPtr]$hWnd, [string]$path) {
  if ($hWnd -eq [IntPtr]::Zero) { return $false }
  $rect = New-Object WinCap+RECT
  if (-not [WinCap]::GetWindowRect($hWnd, [ref]$rect)) { return $false }
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { return $false }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $gfx.GetHdc()
  $ok = [WinCap]::PrintWindow($hWnd, $hdc, 2)
  $gfx.ReleaseHdc($hdc)
  $gfx.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  # Detect an all-black PrintWindow result (common for OpenGL) and fall back to
  # a foreground screen grab of the window rectangle.
  $sample = $bmp.GetPixel([int]($w / 2), [int]($h / 2))
  $bmp.Dispose()
  $dark = ($sample.R -lt 8 -and $sample.G -lt 8 -and $sample.B -lt 8)
  if (-not $ok -or $dark) {
    [WinCap]::ShowWindow($hWnd, 9) | Out-Null
    [WinCap]::SetForegroundWindow($hWnd) | Out-Null
    Start-Sleep -Milliseconds 800
    $bmp2 = New-Object System.Drawing.Bitmap $w, $h
    $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
    $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp2.Size)
    $g2.Dispose()
    $bmp2.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp2.Dispose()
    Log "window capture via screen fallback -> $path (${w}x${h})"
  } else {
    Log "window capture via PrintWindow -> $path (${w}x${h})"
  }
  return $true
}

function Capture-Screen([string]$path) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Log "screen capture -> $path"
}

$capturedLauncher = $false
$capturedLauncherLate = $false
$capturedLoading = $false
$capturedMenu = $false
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$lastWorkspace = $null

while ((Get-Date) -lt $deadline) {
  $ws = Get-NewestWorkspace
  if ($ws -and $ws -ne $lastWorkspace) {
    $lastWorkspace = $ws
    Log "workspace: $ws"
  }
  if ($ws) {
    $gameLog = Join-Path $ws 'mc\versions\1.20.1\logs\latest.log'
    $text = ''
    if (Test-Path $gameLog) { $text = Get-Content -LiteralPath $gameLog -Raw -Encoding UTF8 }

    if (-not $capturedLauncher) {
      $h = Get-WindowHandle @('mc-launcher', 'electron')
      if ($h -ne [IntPtr]::Zero) {
        Start-Sleep -Milliseconds 400
        if (Capture-Window $h (Join-Path $OutDir 'launcher-home.png')) { $capturedLauncher = $true }
      }
    }

    if ($text -and -not $capturedLoading -and $text.Contains('Setting user: TestUser')) {
      Start-Sleep -Seconds 2
      $h = Get-WindowHandle @('javaw', 'java')
      if ($h -ne [IntPtr]::Zero) {
        if (Capture-Window $h (Join-Path $OutDir 'game-loading.png')) { $capturedLoading = $true }
      } else {
        Capture-Screen (Join-Path $OutDir 'game-loading-screen.png')
        $capturedLoading = $true
      }
    }

    if ($text -and $text.Contains('Sound engine started')) {
      Start-Sleep -Seconds 5
      $h = Get-WindowHandle @('javaw', 'java')
      if ($h -ne [IntPtr]::Zero) {
        $capturedMenu = Capture-Window $h (Join-Path $OutDir 'main-menu.png')
        Capture-Screen (Join-Path $OutDir 'main-menu-screen.png')
      } else {
        Capture-Screen (Join-Path $OutDir 'main-menu-screen.png')
        $capturedMenu = $true
      }
      $h2 = Get-WindowHandle @('mc-launcher', 'electron')
      if ($h2 -ne [IntPtr]::Zero) {
        Start-Sleep -Milliseconds 500
        if (Capture-Window $h2 (Join-Path $OutDir 'launcher-home-after-install.png')) { $capturedLauncherLate = $true }
      }
      if ($capturedMenu -and $capturedLauncherLate) { break }
    }
  }
  Start-Sleep -Milliseconds 1500
}

Log "done: launcher=$capturedLauncher launcherLate=$capturedLauncherLate loading=$capturedLoading menu=$capturedMenu"
