# desktop-host.ps1
#
# Long-running host for Windows desktop automation. ETTORE spawns one of
# these per desktop_app session and pipes JSON commands in, JSON responses
# out. Each command line must be a single JSON object terminated by \n.
#
# Wire format (one JSON object per line on each side):
#   -> {"id":"1","action":"list-windows"}
#   <- {"id":"1","ok":true,"windows":[...]}
#   -> {"id":"2","action":"click","x":100,"y":200}
#   <- {"id":"2","ok":true,"x":100,"y":200}
#
# Actions:
#   ping           liveness check
#   quit           graceful shutdown
#   list-windows   enumerate visible top-level windows (hWnd, pid, title, x, y, w, h)
#   get-window     get the geometry + title of one hWnd
#   screenshot     capture the full screen (or one hWnd) to a PNG file
#   focus          restore + foreground one hWnd
#   click          SendInput mouse click at absolute coords (or window-relative)
#   type           SendInput keyboard events for each char
#   press          SendInput key combo (e.g. "ctrl+s", "Return", "F5")

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class W32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg; public ushort wParamL; public ushort wParamH;
  }
}
"@

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PW {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
}
"@

function Emit-Response {
  param([string]$id, [bool]$ok, [hashtable]$extra)
  $obj = New-Object PSObject
  $obj | Add-Member -NotePropertyName id -NotePropertyValue $id
  $obj | Add-Member -NotePropertyName ok -NotePropertyValue $ok
  if ($extra) {
    foreach ($k in $extra.Keys) {
      $obj | Add-Member -NotePropertyName $k -NotePropertyValue $extra[$k]
    }
  }
  $line = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

function Read-Hwnd {
  param($hwndStr)
  if (-not $hwndStr) { throw "hwnd required" }
  $h = $hwndStr -replace '^0x', ''
  return [IntPtr]::new([Convert]::ToInt64($h, 16))
}

function Do-ListWindows {
  param($cmd)
  $list = New-Object System.Collections.ArrayList
  $cb = {
    param($hWnd, $lParam)
    if (-not [W32]::IsWindowVisible($hWnd)) { return $true }
    $len = [W32]::GetWindowTextLength($hWnd)
    if ($len -le 0) { return $true }
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [W32]::GetWindowTextW($hWnd, $sb, $sb.Capacity) | Out-Null
    $title = $sb.ToString().Trim()
    if (-not $title) { return $true }
    $procId = 0
    [W32]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
    $r = New-Object W32+RECT
    [W32]::GetWindowRect($hWnd, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { return $true }
    $obj = New-Object PSObject -Property @{
      id    = ('0x{0:X}' -f $hWnd.ToInt64())
      pid   = [int]$procId
      title = $title
      x     = [int]$r.Left
      y     = [int]$r.Top
      width = [int]$w
      height= [int]$h
    }
    $null = $list.Add($obj)
    return $true
  }
  $del = [W32+EnumWindowsProc]$cb
  [W32]::EnumWindows($del, [IntPtr]::Zero) | Out-Null
  Emit-Response $cmd.id $true @{ windows = @($list) }
}

function Do-GetWindow {
  param($cmd)
  $h = Read-Hwnd $cmd.hwnd
  $r = New-Object W32+RECT
  [W32]::GetWindowRect($h, [ref]$r) | Out-Null
  $sb = New-Object System.Text.StringBuilder 512
  [W32]::GetWindowTextW($h, $sb, $sb.Capacity) | Out-Null
  Emit-Response $cmd.id $true @{
    hwnd   = $cmd.hwnd
    title  = $sb.ToString().Trim()
    x      = [int]$r.Left
    y      = [int]$r.Top
    width  = [int]($r.Right - $r.Left)
    height = [int]($r.Bottom - $r.Top)
  }
}

function Do-Screenshot {
  param($cmd)
  $path = [string]$cmd.path
  if (-not $path) { Emit-Response $cmd.id $false @{ error = 'path required' }; return }
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  if ($cmd.hwnd) {
    $h = Read-Hwnd $cmd.hwnd
    $r = New-Object W32+RECT
    [W32]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $h2 = $r.Bottom - $r.Top
    if ($w -le 0 -or $h2 -le 0) {
      Emit-Response $cmd.id $false @{ error = 'window has zero size' }; return
    }
    $bmp = New-Object System.Drawing.Bitmap $w, $h2
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [PW]::PrintWindow($h, $hdc, 0x2)  # PW_RENDERFULLCONTENT
    $g.ReleaseHdc($hdc)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Emit-Response $cmd.id $true @{ path = $path; width = $w; height = $h2; hwnd = $cmd.hwnd; printWindowOk = $ok }
  } else {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Emit-Response $cmd.id $true @{ path = $path; width = $bounds.Width; height = $bounds.Height }
  }
}

function Do-Focus {
  param($cmd)
  $h = Read-Hwnd $cmd.hwnd
  [W32]::ShowWindow($h, 9) | Out-Null      # SW_RESTORE
  [W32]::SetForegroundWindow($h) | Out-Null
  # Windows is sometimes slow to actually bring the window to the front
  # (especially across DPI-mismatched monitors or with UAC-protected
  # targets). Wait long enough for the user to SEE the focus change.
  Start-Sleep -Milliseconds 400
  Emit-Response $cmd.id $true @{ hwnd = $cmd.hwnd; focused = $true }
}

function Do-AsciiPreview {
  param($cmd)
  $path = [string]$cmd.path
  $width = if ($cmd.width) { [int]$cmd.width } else { 80 }
  $height = if ($cmd.height) { [int]$cmd.height } else { 24 }
  $invert = [bool]$cmd.invert
  if (-not $path -or -not (Test-Path $path)) {
    Emit-Response $cmd.id $false @{ error = "path required and must exist" }; return
  }
  $src = [System.Drawing.Bitmap]::FromFile($path)
  $dst = New-Object System.Drawing.Bitmap $width, $height
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $width, $height)
  $g.Dispose()
  $src.Dispose()
  # 10-step luminance ramp; "@" is darkest, space is brightest. Invert
  # swaps the mapping so a "dark mode" terminal shows light characters
  # on dark backgrounds the way the user expects.
  $ramp = if ($invert) { '@%#*+=:-. ' } else { ' .:-=+*#%@' }
  $sb = New-Object System.Text.StringBuilder
  for ($y = 0; $y -lt $height; $y++) {
    for ($x = 0; $x -lt $width; $x++) {
      $pixel = $dst.GetPixel($x, $y)
      $brightness = (($pixel.R * 0.299) + ($pixel.G * 0.587) + ($pixel.B * 0.114)) / 255
      $idx = [Math]::Min([Math]::Floor($brightness * ($ramp.Length)), $ramp.Length - 1)
      $null = $sb.Append($ramp[$idx])
    }
    if ($y -lt $height - 1) { $null = $sb.Append("`n") }
  }
  $dst.Dispose()
  Emit-Response $cmd.id $true @{
    ascii = $sb.ToString()
    width = $width
    height = $height
    source = $path
  }
}

function Do-Click {
  param($cmd)
  $x = [int]$cmd.x
  $y = [int]$cmd.y
  $button = if ($cmd.button) { [int]$cmd.button } else { 1 }
  if ($cmd.hwnd) {
    $h = Read-Hwnd $cmd.hwnd
    $r = New-Object W32+RECT
    [W32]::GetWindowRect($h, [ref]$r) | Out-Null
    $x += [int]$r.Left
    $y += [int]$r.Top
  }
  [W32]::SetCursorPos($x, $y) | Out-Null
  # Give the user a moment to actually SEE the cursor land on the
  # target. Without this pause, the click happens so fast that a
  # person watching the screen cannot follow the agent.
  Start-Sleep -Milliseconds 150
  $downFlag = if ($button -eq 3) { 0x0008 } else { 0x0002 }   # RIGHTDOWN / LEFTDOWN
  $upFlag   = if ($button -eq 3) { 0x0010 } else { 0x0004 }   # RIGHTUP   / LEFTUP
  $in1 = New-Object W32+INPUT
  $in1.type = 0
  $in1.u = New-Object W32+InputUnion
  $in1.u.mi = New-Object W32+MOUSEINPUT -Property @{ dx=0; dy=0; mouseData=0; dwFlags=$downFlag; time=0; dwExtraInfo=[IntPtr]::Zero }
  $in2 = New-Object W32+INPUT
  $in2.type = 0
  $in2.u = New-Object W32+InputUnion
  $in2.u.mi = New-Object W32+MOUSEINPUT -Property @{ dx=0; dy=0; mouseData=0; dwFlags=$upFlag; time=0; dwExtraInfo=[IntPtr]::Zero }
  $cb = [System.Runtime.InteropServices.Marshal]::SizeOf([Type]'W32+INPUT')
  [W32]::SendInput(2, @($in1, $in2), $cb) | Out-Null
  Emit-Response $cmd.id $true @{ x = $x; y = $y; button = $button }
}

# Map a single key token to a Win32 virtual-key code.
function Get-Vk {
  param([string]$token)
  $t = $token.ToLower().Trim()
  $named = @{
    'ctrl'    = 0x11; 'control' = 0x11
    'lctrl'   = 0xA2; 'rctrl'   = 0xA3
    'alt'     = 0x12
    'lalt'    = 0xA4; 'ralt'    = 0xA5
    'shift'   = 0x10
    'lshift'  = 0xA0; 'rshift'  = 0xA1
    'win'     = 0x5B; 'lwin'    = 0x5B; 'rwin' = 0x5C
    'meta'    = 0x5B
    'return'  = 0x0D; 'enter'   = 0x0D; 'cr' = 0x0D
    'escape'  = 0x1B; 'esc'     = 0x1B
    'tab'     = 0x09
    'space'   = 0x20
    'backspace'=0x08; 'bs'      = 0x08
    'delete'  = 0x2E; 'del'     = 0x2E
    'home'    = 0x24
    'end'     = 0x23
    'pageup'  = 0x21; 'pgup'    = 0x21
    'pagedown'= 0x22; 'pgdn'    = 0x22; 'pgdown' = 0x22
    'left'    = 0x25; 'right'   = 0x27; 'up' = 0x26; 'down' = 0x28
    'insert'  = 0x2D
    'capslock'= 0x14
    'numlock' = 0x90
    'scrolllock' = 0x91
    'printscreen'= 0x2C; 'prtsc'= 0x2C
  }
  if ($named.ContainsKey($t)) { return [uint16]$named[$t] }
  if ($t -match '^f(\d+)$') {
    $n = [int]$Matches[1]
    if ($n -ge 1 -and $n -le 24) { return [uint16](0x6F + $n) }
  }
  if ($t.Length -eq 1) {
    $c = [char]$t.ToUpper()
    $vk = [System.Windows.Forms.Keys]::valueOf($c)
    if ($vk -ne [System.Windows.Forms.Keys]::None) { return [uint16]$vk }
  }
  return $null
}

function Do-Press {
  param($cmd)
  $keys = [string]$cmd.keys
  if (-not $keys) { Emit-Response $cmd.id $false @{ error = 'keys required' }; return }
  $tokens = $keys -split '\+'
  $vkList = New-Object System.Collections.ArrayList
  foreach ($tok in $tokens) {
    $vk = Get-Vk $tok
    if ($null -eq $vk) {
      Emit-Response $cmd.id $false @{ error = "unknown key in combo: '$tok' (try ctrl+s, Return, F5, etc.)" }
      return
    }
    $null = $vkList.Add([uint16]$vk)
  }
  $count = $vkList.Count
  $inputs = New-Object W32+INPUT[] (2 * $count)
  for ($i = 0; $i -lt $count; $i++) {
    $inputs[$i] = New-Object W32+INPUT
    $inputs[$i].type = 1
    $inputs[$i].u = New-Object W32+InputUnion
    $inputs[$i].u.ki = New-Object W32+KEYBDINPUT -Property @{
      wVk = $vkList[$i]; wScan = 0; dwFlags = 0; time = 0; dwExtraInfo = [IntPtr]::Zero
    }
  }
  for ($i = 0; $i -lt $count; $i++) {
    $inputs[$count + $i] = New-Object W32+INPUT
    $inputs[$count + $i].type = 1
    $inputs[$count + $i].u = New-Object W32+InputUnion
    $inputs[$count + $i].u.ki = New-Object W32+KEYBDINPUT -Property @{
      wVk = $vkList[$i]; wScan = 0; dwFlags = 2; time = 0; dwExtraInfo = [IntPtr]::Zero
    }
  }
  $cb = [System.Runtime.InteropServices.Marshal]::SizeOf([Type]'W32+INPUT')
  [W32]::SendInput([uint32](2 * $count), $inputs, $cb) | Out-Null
  Emit-Response $cmd.id $true @{ keys = $keys; count = $count }
}

function Do-Type {
  param($cmd)
  $text = [string]$cmd.text
  if ($null -eq $cmd.text) { Emit-Response $cmd.id $false @{ error = 'text required' }; return }
  $delay = if ($cmd.delay_ms) { [int]$cmd.delay_ms } else { 20 }
  $cb = [System.Runtime.InteropServices.Marshal]::SizeOf([Type]'W32+INPUT')
  $typed = 0
  foreach ($ch in $text.ToCharArray()) {
    $vk = $null
    $needsShift = $false
    if ([char]::IsLetter($ch)) {
      $vk = [System.Windows.Forms.Keys]::valueOf([char][char]::ToUpper($ch))
      $needsShift = [char]::IsUpper($ch)
    } elseif ([char]::IsDigit($ch)) {
      $vk = [System.Windows.Forms.Keys]::valueOf($ch)
    } else {
      $vk = [System.Windows.Forms.Keys]::valueOf($ch)
    }
    if ($null -eq $vk -or $vk -eq [System.Windows.Forms.Keys]::None) { continue }
    $vkCode = [uint16]$vk
    $mod = New-Object W32+INPUT
    $mod.type = 1
    $mod.u = New-Object W32+InputUnion
    if ($needsShift) {
      $mod.u.ki = New-Object W32+KEYBDINPUT -Property @{
        wVk = 0x10; wScan = 0; dwFlags = 0; time = 0; dwExtraInfo = [IntPtr]::Zero
      }
      [W32]::SendInput(1, @($mod), $cb) | Out-Null
    }
    $down = New-Object W32+INPUT
    $down.type = 1
    $down.u = New-Object W32+InputUnion
    $down.u.ki = New-Object W32+KEYBDINPUT -Property @{
      wVk = $vkCode; wScan = 0; dwFlags = 0; time = 0; dwExtraInfo = [IntPtr]::Zero
    }
    $up = New-Object W32+INPUT
    $up.type = 1
    $up.u = New-Object W32+InputUnion
    $up.u.ki = New-Object W32+KEYBDINPUT -Property @{
      wVk = $vkCode; wScan = 0; dwFlags = 2; time = 0; dwExtraInfo = [IntPtr]::Zero
    }
    [W32]::SendInput(2, @($down, $up), $cb) | Out-Null
    if ($needsShift) {
      $rel = New-Object W32+INPUT
      $rel.type = 1
      $rel.u = New-Object W32+InputUnion
      $rel.u.ki = New-Object W32+KEYBDINPUT -Property @{
        wVk = 0x10; wScan = 0; dwFlags = 2; time = 0; dwExtraInfo = [IntPtr]::Zero
      }
      [W32]::SendInput(1, @($rel), $cb) | Out-Null
    }
    if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
    $typed++
  }
  Emit-Response $cmd.id $true @{ chars = $typed }
}

# Main loop
$reader = [Console]::In
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  $cmd = $null
  try {
    $cmd = $line | ConvertFrom-Json
  } catch {
    Emit-Response '?' $false @{ error = "invalid JSON line: $($_.Exception.Message)" }
    continue
  }
  $id = if ($cmd.id) { [string]$cmd.id } else { '?' }
  $action = [string]$cmd.action
  try {
    switch ($action) {
      'ping'         { Emit-Response $id $true @{ pong = $true; pid = $PID } }
      'quit'         { Emit-Response $id $true @{ quit = $true }; exit 0 }
      'list-windows' { Do-ListWindows $cmd }
      'get-window'   { Do-GetWindow $cmd }
      'screenshot'   { Do-Screenshot $cmd }
      'ascii-preview'{ Do-AsciiPreview $cmd }
      'focus'        { Do-Focus $cmd }
      'click'        { Do-Click $cmd }
      'press'        { Do-Press $cmd }
      'type'         { Do-Type $cmd }
      default        { Emit-Response $id $false @{ error = "unknown action: $action" } }
    }
  } catch {
    $msg = "$($_.Exception.GetType().FullName): $($_.Exception.Message)"
    Emit-Response $id $false @{ error = $msg }
  }
}
