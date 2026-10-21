Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class DlgList {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static List<string> all = new List<string>();
  public static bool Callback(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var t = new StringBuilder(512); GetWindowText(h, t, 512);
    var c = new StringBuilder(128); GetClassName(h, c, 128);
    string s = t.ToString();
    if (c.ToString() == "#32770" || s.Contains("模组") || s.Contains("选择")) all.Add(c.ToString() + " | " + s);
    return true;
  }
  public static string[] All() { all.Clear(); EnumWindows(new EnumProc(Callback), IntPtr.Zero); return all.ToArray(); }
}
"@
[DlgList]::All() | ForEach-Object { $_ }
