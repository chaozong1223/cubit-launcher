# t34: capture the Minecraft main menu window started by probe-menu-hold.mjs.
param(
  [string]$GameLog = "D:\DSH-工作文件\mc-launcher\.e2e\e2e-install-H2EdGy\mc\versions\1.20.1\logs\latest.log",
  [string]$OutDir = "D:\DSH-工作文件\mc-launcher\docs\evidence\p0\P0-1",
  [int]$TimeoutSeconds = 150
)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MenuCap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[MenuCap]::SetProcessDPIAware() | Out-Null
$log = Join-Path $OutDir 'capture-menu.log'
function Log([string]$m) { $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Add-Content -Path $log -Value $line -Encoding UTF8; Write-Host $line }
function Get-JavawWindow {
  $p = Get-Process -Name javaw, java -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { return $p.MainWindowHandle }
  return [IntPtr]::Zero
}
function Capture([IntPtr]$hWnd, [string]$path) {
  if ($hWnd -eq [IntPtr]::Zero) { return $false }
  $rect = New-Object MenuCap+RECT
  if (-not [MenuCap]::GetWindowRect($hWnd, [ref]$rect)) { return $false }
  $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { return $false }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc(); $ok = [MenuCap]::PrintWindow($hWnd, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $mid = $bmp.GetPixel([int]($w/2), [int]($h/2)); $bmp.Dispose()
  if (-not $ok -or ($mid.R -lt 8 -and $mid.G -lt 8 -and $mid.B -lt 8)) {
    [MenuCap]::ShowWindow($hWnd, 9) | Out-Null
    [MenuCap]::SetForegroundWindow($hWnd) | Out-Null
    Start-Sleep -Milliseconds 1200
    $bmp2 = New-Object System.Drawing.Bitmap $w, $h
    $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
    $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp2.Size); $g2.Dispose()
    $bmp2.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp2.Dispose()
    Log "screen fallback $path (${w}x${h})"
  } else { Log "PrintWindow $path (${w}x${h})" }
  return $true
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$menu = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path $GameLog) {
    $text = Get-Content -LiteralPath $GameLog -Raw -Encoding UTF8
    if ($text.Contains('Sound engine started')) { $menu = $true; break }
  }
  Start-Sleep -Milliseconds 700
}
if (-not $menu) { Log 'menu marker not found'; exit 2 }
Log 'Sound engine started; waiting for the menu to render'
Start-Sleep -Seconds 5
$hwnd = Get-JavawWindow
$ok = Capture $hwnd (Join-Path $OutDir 'main-menu.png')
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$screen = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$sg = [System.Drawing.Graphics]::FromImage($screen)
$sg.CopyFromScreen($b.X, $b.Y, 0, 0, $screen.Size); $sg.Dispose()
$screen.Save((Join-Path $OutDir 'main-menu-screen.png'), [System.Drawing.Imaging.ImageFormat]::Png); $screen.Dispose()
Log "menu window captured=$ok"
# Launcher window (still running detached).
$lp = Get-Process -Name mc-launcher -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($lp) { Capture $lp.MainWindowHandle (Join-Path $OutDir 'launcher-running.png') | Out-Null }
exit 0
