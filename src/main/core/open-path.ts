import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { shell } from 'electron'

/**
 * Open a file or folder in the OS shell.
 *
 * Two Windows quirks drive this:
 *  - `shell.openPath` pops the raw ShellExecute dialog for a missing target, so
 *    it is only used when the path actually exists;
 *  - a detached `explorer.exe <dir>` opens the folder without focusing it, which
 *    looks like "nothing happened" when the window sits behind the launcher.
 * So: existing target → Electron API (focuses Explorer correctly), otherwise
 * explorer as a last resort. Returns '' on success, else an error message.
 */
export async function openPathInShell(target: string): Promise<string> {
  if (process.platform !== 'win32') return shell.openPath(target)
  try {
    if (fs.existsSync(target)) {
      const error = await shell.openPath(target)
      if (!error) return ''
    }
  } catch {
    /* fall through to explorer */
  }
  try {
    spawn('explorer.exe', [target], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    })
      .unref()
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Open an https URL in the default browser (Windows: through explorer). */
export async function openUrlInShell(url: string): Promise<void> {
  if (!url.startsWith('https://')) throw new Error('refusing to open non-https url')
  if (process.platform === 'win32') {
    spawn('explorer.exe', [url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
    return
  }
  await shell.openExternal(url)
}
