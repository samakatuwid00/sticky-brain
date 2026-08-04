# Generates build/icon.ico and build/tray.png from the board's own tokens.
# A sticky slip on the terminal ground, with the folded top-right corner the pending
# cards use as their form marker. Reproducible on purpose - the icon is not a binary
# blob checked in from nowhere.

param([string]$OutDir = "$PSScriptRoot")

Add-Type -AssemblyName System.Drawing

$GROUND  = [System.Drawing.ColorTranslator]::FromHtml('#0f0e0c')
$SURFACE = [System.Drawing.ColorTranslator]::FromHtml('#1d1a16')
$ACCENT  = [System.Drawing.ColorTranslator]::FromHtml('#c67139')
$HAIRLIN = [System.Drawing.ColorTranslator]::FromHtml('#2b2620')
$TEXTHI  = [System.Drawing.ColorTranslator]::FromHtml('#f5ead8')

function New-Icon([int]$S) {
  $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $u = $S / 32.0                       # design grid: 32 units
  $r = [int](6 * $u)                   # window radius

  # rounded ground
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($S - $d, 0, $d, $d, 270, 90)
  $path.AddArc($S - $d, $S - $d, $d, $d, 0, 90)
  $path.AddArc(0, $S - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush($GROUND)), $path)
  $g.DrawPath((New-Object System.Drawing.Pen($HAIRLIN, [Math]::Max(1, $u))), $path)

  # accent dot - the title bar mark
  $dot = [int](3 * $u)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush($ACCENT)), [int](4 * $u), [int](4 * $u), $dot, $dot)

  # the slip, with its corner folded away
  $x0 = [int](4 * $u); $y0 = [int](11 * $u)
  $w  = [int](24 * $u); $h = [int](17 * $u)
  $fold = [int](7 * $u)
  $slip = New-Object System.Drawing.Drawing2D.GraphicsPath
  # Must be a typed Point[]; an untyped @() picks the wrong AddLines overload and throws.
  $pts = [System.Drawing.Point[]]@(
    (New-Object System.Drawing.Point($x0, $y0)),
    (New-Object System.Drawing.Point(($x0 + $w - $fold), $y0)),
    (New-Object System.Drawing.Point(($x0 + $w), ($y0 + $fold))),
    (New-Object System.Drawing.Point(($x0 + $w), ($y0 + $h))),
    (New-Object System.Drawing.Point($x0, ($y0 + $h))))
  $slip.AddLines($pts)
  $slip.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush($SURFACE)), $slip)
  $g.DrawPath((New-Object System.Drawing.Pen($ACCENT, [Math]::Max(1, 1.2 * $u))), $slip)

  # two text rules - only at sizes where they read as lines rather than mud
  if ($S -ge 32) {
    $bar = New-Object System.Drawing.SolidBrush($TEXTHI)
    $g.FillRectangle($bar, $x0 + [int](3 * $u), $y0 + [int](5 * $u), [int](13 * $u), [Math]::Max(1, [int](1.6 * $u)))
    $dim = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(160, $ACCENT))
    $g.FillRectangle($dim, $x0 + [int](3 * $u), $y0 + [int](9 * $u), [int](9 * $u), [Math]::Max(1, [int](1.6 * $u)))
  }

  $g.Dispose()
  return $bmp
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$paths = @()
foreach ($s in $sizes) {
  $bmp = New-Icon $s
  $p = Join-Path $OutDir "icon-$s.png"
  $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $paths += $p
}

# tray needs a small standalone png
Copy-Item (Join-Path $OutDir 'icon-32.png') (Join-Path $OutDir 'tray.png') -Force
Copy-Item (Join-Path $OutDir 'icon-256.png') (Join-Path $OutDir 'icon.png') -Force

# the tray icon is loaded at runtime, so it must ship inside the app, not only in build/
$assets = Join-Path (Split-Path $OutDir -Parent) 'src\assets'
if (-not (Test-Path $assets)) { New-Item -ItemType Directory $assets | Out-Null }
Copy-Item (Join-Path $OutDir 'icon-16.png') (Join-Path $assets 'tray.png') -Force
Copy-Item (Join-Path $OutDir 'icon-32.png') (Join-Path $assets 'tray@2x.png') -Force

"generated: $($paths.Count) sizes in $OutDir"
