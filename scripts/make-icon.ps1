# Generate build/icon.ico + build/icon.png for Cubit Launcher.
#
# Design: rounded-square tile in the launcher's green, with a white isometric
# cube in the middle (the "block" the whole app is about). Drawn with GDI+ so
# no external image tooling is required.
#
# Usage: pwsh -File scripts/make-icon.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outIco = Join-Path $root 'build/icon.ico'
$outPng = Join-Path $root 'build/icon.png'

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  # --- background: rounded square with a top-left to bottom-right green gradient
  $pad = [math]::Max(1, [int]($size * 0.04))
  $rect = New-Object System.Drawing.Rectangle($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))
  $radius = [int]($size * 0.24)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 45, 164, 110),   # deeper green
    [System.Drawing.Color]::FromArgb(255, 92, 219, 148),   # brighter green
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  $g.FillPath($brush, $path)
  $brush.Dispose()

  # --- isometric cube (three faces, different opacity of white)
  $cx = $size / 2.0
  $cy = $size / 2.0
  $r = $size * 0.27           # half-width of the cube's top diamond
  $h = $size * 0.155          # vertical half-height of the top diamond
  $drop = $size * 0.27        # side face height

  $top = New-Object System.Drawing.PointF[] 3
  $left = New-Object System.Drawing.PointF[] 3
  $right = New-Object System.Drawing.PointF[] 3
  $argb = {
    param([int]$a)
    [System.Drawing.Color]::FromArgb($a, 255, 255, 255)
  }
  $top[0] = New-Object System.Drawing.PointF($cx, ($cy - $h - $drop / 2))
  $top[1] = New-Object System.Drawing.PointF(($cx + $r), ($cy - $drop / 2))
  $top[2] = New-Object System.Drawing.PointF($cx, ($cy + $h - $drop / 2))
  $topBack = New-Object System.Drawing.PointF(($cx - $r), ($cy - $drop / 2))

  $left[0] = $topBack
  $left[1] = New-Object System.Drawing.PointF($cx, ($cy + $h - $drop / 2))
  $left[2] = New-Object System.Drawing.PointF($cx, ($cy + $h + $drop / 2))
  $leftTop = New-Object System.Drawing.PointF(($cx - $r), ($cy - $drop / 2 + $drop))
  $left[1] = New-Object System.Drawing.PointF($cx, ($cy + $h - $drop / 2))
  $left[2] = New-Object System.Drawing.PointF($cx, ($cy + $h + $drop / 2))
  # left face: 4 points -> use a closed polygon
  $leftFace = @($leftTop, (New-Object System.Drawing.PointF($cx, ($cy + $h + $drop / 2))), (New-Object System.Drawing.PointF($cx, ($cy - $h - $drop / 2 + $drop))), $topBack)

  $bTop = New-Object System.Drawing.SolidBrush((& $argb 255))
  $bLeft = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(228, 255, 255, 255))
  $bRight = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(178, 255, 255, 255))

  $g.FillPolygon($bTop, @(
    (New-Object System.Drawing.PointF($cx, ($cy - $h - $drop / 2))),
    (New-Object System.Drawing.PointF(($cx + $r), ($cy - $drop / 2))),
    (New-Object System.Drawing.PointF($cx, ($cy + $h - $drop / 2))),
    $topBack
  ))
  $g.FillPolygon($bLeft, @(
    $topBack,
    (New-Object System.Drawing.PointF($cx, ($cy + $h - $drop / 2))),
    (New-Object System.Drawing.PointF($cx, ($cy + $h + $drop / 2))),
    (New-Object System.Drawing.PointF(($cx - $r), ($cy + $drop / 2)))
  ))
  $g.FillPolygon($bRight, @(
    (New-Object System.Drawing.PointF(($cx + $r), ($cy - $drop / 2))),
    (New-Object System.Drawing.PointF(($cx + $r), ($cy + $drop / 2))),
    (New-Object System.Drawing.PointF($cx, ($cy + $h + $drop / 2))),
    (New-Object System.Drawing.PointF($cx, ($cy + $h - $drop / 2)))
  ))

  $bTop.Dispose(); $bLeft.Dispose(); $bRight.Dispose()
  $path.Dispose()
  $g.Dispose()
  return $bmp
}

# 256px master PNG (electron-builder / store listings)
$master = New-IconBitmap 256
$master.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)

# Multi-size ICO (PNG-compressed entries are valid for Vista+)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngBytes = @()
foreach ($size in $sizes) {
  $bmp = if ($size -eq 256) { $master } else { New-IconBitmap $size }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes += , $ms.ToArray()
  $ms.Dispose()
  if ($size -ne 256) { $bmp.Dispose() }
}

$fs = [System.IO.File]::Create($outIco)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)              # reserved
$bw.Write([UInt16]1)              # type: icon
$bw.Write([UInt16]$sizes.Count)   # image count
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))   # width
  $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))   # height
  $bw.Write([Byte]0)              # palette
  $bw.Write([Byte]0)              # reserved
  $bw.Write([UInt16]1)            # planes
  $bw.Write([UInt16]32)           # bit depth
  $bw.Write([UInt32]$pngBytes[$i].Length)
  $bw.Write([UInt32]$offset)
  $offset += $pngBytes[$i].Length
}
foreach ($bytes in $pngBytes) { $bw.Write($bytes) }
$bw.Flush(); $bw.Close(); $fs.Close()
$master.Dispose()

Write-Host "icon.png : $outPng"
Write-Host "icon.ico : $outIco ($([math]::Round((Get-Item $outIco).Length / 1KB, 1)) KB, $($sizes.Count) sizes)"
