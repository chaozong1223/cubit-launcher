# t45: drive the native "选择模组" file dialog via keyboard (Alt+N, path, Enter).
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Dlg2 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public static IntPtr found = IntPtr.Zero;
  public static bool Callback(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var cls = new StringBuilder(128); GetClassName(h, cls, 128);
    if (cls.ToString() != "#32770") return true;
    var t = new StringBuilder(512); GetWindowText(h, t, 512);
    string s = t.ToString();
    if (s.Length > 0 && s != "no_active_wnd") { found = h; return false; }
    return true;
  }
  public static IntPtr Find() {
    found = IntPtr.Zero;
    EnumWindows(new EnumProc(Callback), IntPtr.Zero);
    return found;
  }
}
"@
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 80; $i++) {
  $hwnd = [Dlg2]::Find()
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 250
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'DIALOG_NOT_FOUND'; exit 2 }
[Dlg2]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 900
[System.Windows.Forms.SendKeys]::SendWait('%n')
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait($Path)
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output "DIALOG_FILLED $Path"
exit 0
