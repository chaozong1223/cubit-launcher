# t45: fill the native file dialog via UI Automation (filename edit + Open button).
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class Dlg3 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static IntPtr found = IntPtr.Zero;
  public static bool Cb(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var c = new StringBuilder(128); GetClassName(h, c, 128);
    if (c.ToString() != "#32770") return true;
    var t = new StringBuilder(512); GetWindowText(h, t, 512);
    string s = t.ToString();
    if (s.Length > 0 && s != "no_active_wnd") { found = h; return false; }
    return true;
  }
  public static IntPtr Find() { found = IntPtr.Zero; EnumWindows(new EnumProc(Cb), IntPtr.Zero); return found; }
}
"@
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 80; $i++) {
  $hwnd = [Dlg3]::Find()
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 250
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'DIALOG_NOT_FOUND'; exit 2 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
$target = $null
foreach ($e in $edits) {
  if ($e.Current.AutomationId -eq '1148') { $target = $e; break }
}
if (-not $target -and $edits.Count -gt 0) { $target = $edits[$edits.Count - 1] }
if (-not $target) { Write-Output 'EDIT_NOT_FOUND'; exit 3 }
$target.SetFocus()
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait($Path)
Start-Sleep -Milliseconds 500
$buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
$open = $null
foreach ($b in $buttons) {
  if ($b.Current.AutomationId -eq '1') { $open = $b; break }
}
if ($open) { $open.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Write-Output "OPEN_CLICKED $Path"; exit 0 }
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output "ENTER_SENT $Path"
exit 0
