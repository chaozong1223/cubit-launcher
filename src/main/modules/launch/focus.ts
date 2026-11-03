import { execFile } from 'node:child_process'
import type { ScopedLogger } from '../../kernel/logger'

/**
 * Bring the freshly spawned game window to the front.
 *
 * A window created by a child process starts *behind* the launcher, and Windows'
 * foreground lock keeps it there until the user clicks its taskbar button — the
 * game then looks like it never started even though it is loading fine
 * (measured 2026-11-03: window visible at (528,295) 870×519, completely hidden
 * behind the launcher and a chat window).
 *
 * The search deliberately ignores `IsWindowVisible`/title: a window that is
 * hidden, has a zero title, or was pushed off-screen still holds the game, and
 * those are exactly the cases worth repairing. It picks the largest window of
 * the child pid, forces it back to a sane rectangle on screen, and repeats the
 * activation a few times because the first attempt often loses the race with
 * the launcher's own minimise/restore.
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
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public static IntPtr FindLargest(uint target) {
    IntPtr best = IntPtr.Zero;
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
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static void GetRect(IntPtr hWnd, out int left, out int top, out int width, out int height) {
    RECT r;
    GetWindowRect(hWnd, out r);
    left = r.Left; top = r.Top; width = r.Right - r.Left; height = r.Bottom - r.Top;
  }
}
"@
$target = ${pid}
for ($i = 0; $i -lt ${iterations}; $i++) {
  $h = [GameWindowFocus]::FindLargest([uint32]$target)
  if ($h -ne [IntPtr]::Zero) {
    [int]$l = 0; [int]$t = 0; [int]$w = 0; [int]$ht = 0
    [void][GameWindowFocus]::GetRect($h, [ref]$l, [ref]$t, [ref]$w, [ref]$ht)
    Write-Output ("found handle=" + $h + " rect=" + $l + "," + $t + " " + $w + "x" + $ht)
    for ($k = 0; $k -lt 3; $k++) {
      [void][GameWindowFocus]::ShowWindow($h, 9)
      [void][GameWindowFocus]::SetWindowPos($h, [IntPtr]::Zero, 80, 80, 1600, 900, 0x0040)
      [void][GameWindowFocus]::BringWindowToTop($h)
      [void][GameWindowFocus]::SetForegroundWindow($h)
      Start-Sleep -Milliseconds 800
    }
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
