$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outputPath = Join-Path $PSScriptRoot 'staff-transaction-records-plan.png'
$bitmap = [System.Drawing.Bitmap]::new(1600, 900)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::FromArgb(8, 8, 8))

function Color([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function Rect([int]$x, [int]$y, [int]$w, [int]$h, [string]$hex) {
  $brush = [System.Drawing.SolidBrush]::new((Color $hex))
  $graphics.FillRectangle($brush, $x, $y, $w, $h)
  $brush.Dispose()
}
function Line([int]$x1, [int]$y1, [int]$x2, [int]$y2, [string]$hex, [int]$width = 1) {
  $pen = [System.Drawing.Pen]::new((Color $hex), $width)
  $graphics.DrawLine($pen, $x1, $y1, $x2, $y2)
  $pen.Dispose()
}
function RoundRect([int]$x, [int]$y, [int]$w, [int]$h, [int]$radius, [string]$fill, [string]$stroke = '') {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $radius * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $brush = [System.Drawing.SolidBrush]::new((Color $fill))
  $graphics.FillPath($brush, $path)
  $brush.Dispose()
  if ($stroke) {
    $pen = [System.Drawing.Pen]::new((Color $stroke))
    $graphics.DrawPath($pen, $path)
    $pen.Dispose()
  }
  $path.Dispose()
}
function Text([string]$value, [int]$x, [int]$y, [int]$w, [int]$h, [int]$size, [string]$hex, [bool]$bold = $false, [string]$align = 'left') {
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $font = [System.Drawing.Font]::new('Segoe UI', $size, $style)
  $brush = [System.Drawing.SolidBrush]::new((Color $hex))
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = switch ($align) { 'center' { [System.Drawing.StringAlignment]::Center } 'right' { [System.Drawing.StringAlignment]::Far } default { [System.Drawing.StringAlignment]::Near } }
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
  $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
  $graphics.DrawString($value, $font, $brush, [System.Drawing.RectangleF]::new($x, $y, $w, $h), $format)
  $format.Dispose(); $brush.Dispose(); $font.Dispose()
}
function Input([string]$label, [string]$value, [int]$x, [int]$w) {
  Text $label $x 253 $w 22 11 '#B5B8BF' $true
  RoundRect $x 279 $w 49 12 '#1B1B1B' '#494949'
  Text $value ($x + 15) 282 ($w - 36) 42 14 '#F6F6F6'
}
function Badge([string]$value, [int]$x, [int]$y, [int]$w, [string]$fill, [string]$foreground) {
  RoundRect $x $y $w 31 15 $fill
  Text $value $x $y $w 31 12 $foreground $true 'center'
}

# Frame and sidebar match the current staff portal palette.
Rect 0 0 268 900 '#111111'
Line 267 0 267 900 '#383838'
RoundRect 28 30 48 48 24 '#FF8500'
Text 'IS' 28 30 48 48 18 '#111111' $true 'center'
Text 'IñigoSync' 90 30 150 46 20 '#FFFFFF' $true
Text 'STAFF PORTAL' 29 92 200 26 12 '#C3C5CA' $true
Text 'OPERATIONS' 30 153 205 24 11 '#B2B4B8' $true
Text 'Booking Overview' 58 196 190 38 14 '#E6E7EA' $true
Text 'Walk-In Management' 58 246 190 38 13 '#E6E7EA' $true
Text 'Court Schedule' 58 296 190 38 14 '#E6E7EA' $true
RoundRect 20 344 228 49 12 '#FF8500'
Text 'Transaction Records' 58 348 184 40 13 '#111111' $true
Text 'ACCOUNT' 30 424 205 24 11 '#B2B4B8' $true
Text 'Account Settings' 58 465 190 38 14 '#E6E7EA' $true

Text 'Transaction Records' 305 26 680 44 23 '#FFFFFF' $true
Text 'Staff collections and visit records for bookings and walk-ins.' 305 72 790 30 14 '#C1C6D1'
Line 268 110 1600 110 '#333333'
RoundRect 1306 32 244 42 21 '#1A1A1A' '#404040'
Text '●  Sat, Oct 31 · 9:38 PM' 1325 35 206 35 13 '#D2D6DD'

# Panel, tabs, and an aligned single filter row.
RoundRect 302 145 1252 655 18 '#1A1A1A' '#4A4A4A'
RoundRect 337 177 201 42 20 '#FF8500'
Text 'Transactions' 348 179 178 38 13 '#141414' $true 'center'
RoundRect 551 177 179 42 20 '#1A1A1A' '#555555'
Text 'Unattended' 561 179 158 38 13 '#E6E7EA' $true 'center'
Text 'Illustrative sample data' 1170 182 344 30 12 '#A8ADB6' $false 'right'

Input 'SEARCH' 'Customer or transaction ID' 338 364
Input 'VISIT DATE' 'Any date  ▾' 718 183
Input 'SOURCE' 'Source  ▾' 917 178
Input 'VISIT STATUS' 'Status  ▾' 1111 192
Input 'SORT' '↓  Newest first' 1319 194

# Seven readable columns fit the panel without horizontal scrolling.
Rect 337 354 1177 47 '#101010'
Text 'TRANSACTION ID' 354 357 157 40 11 '#FFFFFF' $true
Text 'CUSTOMER NAME' 516 357 202 40 11 '#FFFFFF' $true
Text 'TIME IN / TIME OUT' 731 357 225 40 11 '#FFFFFF' $true
Text 'SOURCE' 972 357 111 40 11 '#FFFFFF' $true
Text 'VISIT STATUS' 1090 357 125 40 11 '#FFFFFF' $true
Text 'AMOUNT' 1231 357 116 40 11 '#FFFFFF' $true
Text 'RECORD' 1360 357 135 40 11 '#FFFFFF' $true

Line 337 401 1514 401 '#414141'
Line 337 511 1514 511 '#414141'
Line 337 621 1514 621 '#414141'
Line 337 731 1514 731 '#414141'

Text 'TX-2026-0184' 354 423 157 42 13 '#F2F2F2' $true
Text 'Maria Dela Cruz' 516 423 202 42 14 '#FFFFFF' $true
Text 'Oct 31 · 6:05 PM' 731 417 225 30 13 '#FFFFFF'
Text 'Out: 8:02 PM' 731 446 225 26 12 '#B5B8BF'
Badge 'BOOKING' 970 429 92 '#1C3028' '#54D5A0'
Badge 'COMPLETED' 1088 429 113 '#243128' '#72D99C'
Text '₱650.00' 1231 423 116 42 14 '#FFFFFF' $true
RoundRect 1360 426 137 40 20 '#FF8500'
Text 'View receipt' 1362 428 133 35 12 '#111111' $true 'center'

Text 'TX-2026-0183' 354 533 157 42 13 '#F2F2F2' $true
Text 'Luis R. Manguiat' 516 533 202 42 14 '#FFFFFF' $true
Text 'Oct 31 · 1:16 PM' 731 527 225 30 13 '#FFFFFF'
Text 'Out: 2:20 PM' 731 556 225 26 12 '#B5B8BF'
Badge 'WALK-IN' 970 539 92 '#482B1D' '#FF8A30'
Badge 'COMPLETED' 1088 539 113 '#243128' '#72D99C'
Text '₱1,300.00' 1231 533 116 42 14 '#FFFFFF' $true
RoundRect 1360 536 137 40 20 '#FF8500'
Text 'View receipt' 1362 538 133 35 12 '#111111' $true 'center'

Text 'TX-2026-0182' 354 643 157 42 13 '#F2F2F2' $true
Text 'Jamie Santos' 516 643 202 42 14 '#FFFFFF' $true
Text 'Oct 31 · 7:10 PM' 731 637 225 30 13 '#FFFFFF'
Text 'Out: —' 731 666 225 26 12 '#B5B8BF'
Badge 'BOOKING' 970 649 92 '#1C3028' '#54D5A0'
Badge 'IN PROGRESS' 1088 649 113 '#393320' '#F0C66A'
Text '₱0.00' 1231 636 116 36 14 '#FFFFFF' $true
Text 'Prepaid' 1231 669 116 22 11 '#AEB4BD'
RoundRect 1360 646 137 40 20 '#FF8500'
Text 'View receipt' 1362 648 133 35 12 '#111111' $true 'center'

Text 'Amount = money collected by staff at time-in. A prepaid booking receives a ₱0.00 staff transaction receipt.' 351 746 1137 31 11 '#ADB2BB'

$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output $outputPath
