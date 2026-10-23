import { spawn } from 'node:child_process'
import { shell } from 'electron'

/**
 * Open a file or folder in the OS shell.
 *
 * On this Windows setup `shell.openPath` sometimes pops the raw ShellExecute
 * dialog ("Windows 无法访问指定设备、路径或文件") instead of returning an error,
 * and `shell.openExternal` can resolve while doing nothing. Explorer uses the
 * same file associations without surfacing that dialog, so it is the primary
 * path on Windows. Returns '' on success, otherwise the error message.
 */
export async function openPathInShell(target: string): Promise<string> {
  if (process.platform === 'win32') {
    try {
      spawn('explorer.exe', [target], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      }).unref()
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  return shell.openPath(target)
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
