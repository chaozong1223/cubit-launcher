import { execFile } from 'node:child_process'
import type { ScopedLogger } from '../../kernel/logger'

/**
 * Bring the freshly spawned game window to the front.
 *
 * A window created by a child process is often not just *behind* the launcher
 * but flagged invisible: measured 2026-11-03, the 1.12.2 client had
 * `vis=0 rect=-5,-5 1936x1100 class=LWJGL title='Minecraft 拔刀之旅'` while the
 * title-screen music played. `ShowWindow(SW_RESTORE)` made it appear instantly.
 *
 * The search ignores visibility and title (a hidden or off-screen window is the
 * case worth repairing), picks the largest window of the child pid, and forces
 * it back to a sane rectangle on screen.
 *
 * Two PowerShell pitfalls this file deliberately avoids:
 * - `IntPtr` compares unreliably in PowerShell (a boxed value never equals
 *   `[IntPtr]::Zero`), which made an earlier version "find" a handle and then
 *   activate handle 0. Handles cross the boundary as `long`.
 * - one activation loses the race with the launcher's own minimise/restore, so
 *   it is repeated three times.
 *
 * Electron has no API for another process's window, so this shells out to
 * PowerShell (user32 only, no file writes). Fire-and-forget: failures are
 * logged and never affect the launch.
 */

export interface FocusOptions {
  log?: ScopedLogger
  /** How long to keep looking for the window, in milliseconds. */
  timeoutMs?: number
  pollMs?: number
}

/** Exported for the unit test: the script must target the right PID. */
export function buildFocusScript(pid: number, timeoutMs = 180_000, pollMs = 500): string {
  const iterations = Math.max(1, Math.ceil(timeoutMs / pollMs))
  return `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class GameWindowFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

  // Returns 0 when there is nothing worth activating. A plain long keeps the
  // PowerShell comparison honest.
  public static long FindLargest(uint target) {
    long best = 0;
    int bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left;
      int hh = r.Bottom - r.Top;
      if (w < 100 || hh < 100) return true;
      int area = w * hh;
      if (area > bestArea) { bestArea = area; best = h.ToInt64(); }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static void Activate(long handle) {
    IntPtr h = new IntPtr(handle);
    int w = Math.Min(1920, GetSystemMetrics(0));
    int hh = Math.Min(1080, GetSystemMetrics(1));
    ShowWindow(h, 9);                                   // SW_RESTORE
    SetWindowPos(h, IntPtr.Zero, 0, 0, w, hh, 0x0040);  // SWP_SHOWWINDOW
    BringWindowToTop(h);
    SetForegroundWindow(h);
  }

  public static string Describe(long handle) {
    IntPtr h = new IntPtr(handle);
    RECT r;
    GetWindowRect(h, out r);
    return "handle=" + handle + " visible=" + (IsWindowVisible(h) ? 1 : 0)
      + " rect=" + r.Left + "," + r.Top + " " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
  }
}
"@
$target = ${pid}
for ($i = 0; $i -lt ${iterations}; $i++) {
  $h = [GameWindowFocus]::FindLargest([uint32]$target)
  if ($h -ne 0) {
    for ($k = 0; $k -lt 3; $k++) {
      [GameWindowFocus]::Activate($h)
      Start-Sleep -Milliseconds 800
    }
    Write-Output ([GameWindowFocus]::Describe($h))
    exit 0
  }
  Start-Sleep -Milliseconds ${pollMs}
}
Write-Output "not found"
exit 1
`.trim()
}

/** Fire-and-forget: pull the game window forward once it exists. */
export function focusGameWindow(pid: number, options: FocusOptions = {}): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  const script = buildFocusScript(pid, options.timeoutMs, options.pollMs)
  try {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: (options.timeoutMs ?? 180_000) + 30_000 },
      (error, stdout) => {
        const result = String(stdout ?? '').trim().split(/\r?\n/).pop() ?? ''
        if (result) {
          options.log?.info('game window focus', { pid, result: result.slice(0, 300) })
        }
        if (error) {
          options.log?.warn('game window focus failed', {
            pid,
            message: error.message,
          })
        }
      },
    )
  } catch (error) {
    options.log?.warn('game window focus could not start', {
      pid,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
