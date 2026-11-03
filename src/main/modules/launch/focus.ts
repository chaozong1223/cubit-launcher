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
 * Electron has no API for another process's window, so this shells out to
 * PowerShell (user32 only, no file writes) and polls until the window exists.
 * Fire-and-forget: failures are logged and never affect the launch.
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
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public static IntPtr Find(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target) return true;
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.Length == 0) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$target = ${pid}
for ($i = 0; $i -lt ${iterations}; $i++) {
  $h = [GameWindowFocus]::Find([uint32]$target)
  if ($h -ne [IntPtr]::Zero) {
    [void][GameWindowFocus]::ShowWindow($h, 9)
    [void][GameWindowFocus]::BringWindowToTop($h)
    [void][GameWindowFocus]::SetForegroundWindow($h)
    exit 0
  }
  Start-Sleep -Milliseconds ${pollMs}
}
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
      (error) => {
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
