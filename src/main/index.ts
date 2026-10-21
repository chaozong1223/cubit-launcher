import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { RendererReadyReport } from '@shared/channels'
import type { AppInfo } from '@shared/system'
import { loadConfig, saveConfig } from './kernel/config'
import { registerIpc } from './kernel/ipc'
import { Logger } from './kernel/logger'
import {
  buildPaths,
  ensureWritableDir,
  resolveDataRoot,
  resolveMcRoot,
  type DataRootResolution,
  type BootPaths,
} from './kernel/paths'
import {
  applySessionSecurity,
  applyWindowSecurity,
  installAppProtocol,
  isTrustedUrl,
  loadRenderer,
  registerAppScheme,
} from './kernel/security'
import { registerModules } from './modules/_registry'
import { getService } from './modules/_services'

interface LaunchShutdown {
  hasRunningSessions?: () => boolean
  stopAll?: () => Promise<void>
  stopAllSync?: () => void
}

registerAppScheme()

const smokeMode = process.env.MCL_SMOKE === '1'
const cwd = process.cwd()
const exeDir = (() => {
  try {
    return path.dirname(app.getPath('exe'))
  } catch {
    return cwd
  }
})()
const appDataDir = (() => {
  try {
    return app.getPath('appData')
  } catch {
    return process.env.APPDATA ?? path.join(cwd, '.appdata')
  }
})()

let rootResolution: DataRootResolution = resolveDataRoot({
  argv: process.argv,
  env: process.env,
  cwd,
  exeDir,
  appDataDir,
  isPackaged: app.isPackaged,
})
let pathWarning: string | null = null

if (!ensureWritableDir(rootResolution.dataRoot)) {
  const fallback = path.resolve(appDataDir, 'mc-launcher')
  if (ensureWritableDir(fallback)) {
    pathWarning = `portable data root is not writable, using ${fallback}`
    rootResolution = { ...rootResolution, dataRoot: fallback, portable: false, source: 'user' }
  } else {
    throw new Error(`no writable data directory: ${rootResolution.dataRoot}`)
  }
}

const loaded = loadConfig(rootResolution.dataRoot)
const mcRoot = resolveMcRoot(
  { argv: process.argv, env: process.env, cwd },
  loaded.config.paths.minecraftRoot,
)
const paths: BootPaths = buildPaths(rootResolution, mcRoot)

for (const dir of [
  paths.dataRoot,
  paths.logDir,
  paths.sessionData,
  paths.cache,
  paths.temp,
  paths.crashDumps,
]) {
  ensureWritableDir(dir)
}

// Keep Chromium's profile/cache inside the same private data root. This is the
// behaviour required by the architecture's portable mode.
app.setPath('userData', paths.dataRoot)
app.setPath('sessionData', paths.sessionData)
app.setPath('cache', paths.cache)
app.setPath('logs', paths.logDir)
app.setPath('crashDumps', paths.crashDumps)
app.setPath('temp', paths.temp)
app.setName('mc-launcher')

const logger = new Logger({ dataRoot: paths.dataRoot })

if (pathWarning) logger.warn('app', 'portable root fallback', { message: pathWarning })
if (loaded.recovered) logger.warn('config', 'corrupt config recovered', { file: loaded.file })

loaded.config.lastRunAt = Date.now()
saveConfig(loaded.file, loaded.config)

logger.info('app', 'boot', {
  version: app.getVersion(),
  electron: process.versions.electron ?? 'unknown',
  chrome: process.versions.chrome ?? 'unknown',
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  dataRoot: paths.dataRoot,
  mcRoot: paths.mcRoot,
  portable: paths.portable,
  source: paths.source,
  packaged: app.isPackaged,
})

let moduleIds: string[] = ['system']
let failedModules: string[] = []
let mainWindow: BrowserWindow | null = null
let rendererReport: RendererReadyReport | null = null
let smokeTimer: NodeJS.Timeout | null = null
let smokeFinished = false

function getInfo(): AppInfo {
  return {
    version: app.getVersion(),
    name: app.getName(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    dataRoot: paths.dataRoot,
    mcRoot: paths.mcRoot,
    portable: paths.portable,
    configFile: loaded.file,
    logFile: logger.humanLogFile,
    modules: ['system', ...moduleIds],
    failedModules,
    security: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
}

async function openDataDir(): Promise<{ opened: boolean }> {
  const error = await shell.openPath(paths.dataRoot)
  if (error) logger.warn('shell', 'open data dir failed', { message: error })
  return { opened: error === '' }
}

function writeSmoke(marker: 'ok' | 'fail', payload: Record<string, unknown>): void {
  if (!smokeMode || smokeFinished) return
  smokeFinished = true
  const file = path.join(paths.dataRoot, marker === 'ok' ? 'smoke-ok.json' : 'smoke-fail.json')
  try {
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (error) {
    logger.error('smoke', 'marker write failed', { message: String(error) })
  }
  if (smokeTimer) {
    clearTimeout(smokeTimer)
    smokeTimer = null
  }
  setTimeout(() => app.quit(), 350)
}

function smokeFailure(reason: string): void {
  logger.error('smoke', 'smoke failed', { reason })
  const win = mainWindow
  writeSmoke('fail', {
    ok: false,
    reason,
    version: app.getVersion(),
    dataRoot: paths.dataRoot,
    portable: paths.portable,
    windowVisible: win?.isVisible() ?? false,
    title: win?.getTitle() ?? '',
    url: win?.webContents.getURL() ?? '',
    at: new Date().toISOString(),
  })
}

function handleRendererReady(report: RendererReadyReport): void {
  rendererReport = report
  logger.info('app', 'renderer ready', {
    version: report.version,
    errors: report.errors.length,
    nodeRequire: report.nodeRequire,
    nodeProcess: report.nodeProcess,
    blockedChannelRejected: report.blockedChannelRejected,
    href: report.href,
  })

  if (!smokeMode || smokeFinished) return

  const win = mainWindow
  if (win && !win.isVisible()) win.show()

  setTimeout(() => {
    const current = mainWindow
    const errors = report.errors ?? []
    const visible = current?.isVisible() ?? false
    const ok =
      visible &&
      errors.length === 0 &&
      report.nodeRequire === false &&
      report.nodeProcess === false &&
      report.blockedChannelRejected === true &&
      report.version.length > 0 &&
      report.version === app.getVersion()

    const payload = {
      ok,
      version: app.getVersion(),
      rendererVersion: report.version,
      dataRoot: paths.dataRoot,
      portable: paths.portable,
      windowVisible: visible,
      title: current?.getTitle() ?? '',
      url: current?.webContents.getURL() ?? '',
      rendererReady: true,
      rendererErrors: errors,
      nodeRequire: report.nodeRequire,
      nodeProcess: report.nodeProcess,
      blockedChannelRejected: report.blockedChannelRejected,
      at: new Date().toISOString(),
    }

    logger.info('smoke', ok ? 'smoke passed' : 'smoke failed', payload)
    writeSmoke(ok ? 'ok' : 'fail', payload)
  }, 250)
}

function createMainWindow(): void {
  const win = new BrowserWindow({
    width: loaded.config.app.window.width,
    height: loaded.config.app.window.height,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0F1316' : '#F4F6F8',
    title: 'mc-launcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  })
  mainWindow = win
  win.setMenuBarVisibility(false)
  applyWindowSecurity(win)

  win.once('ready-to-show', () => {
    win.show()
    logger.info('window', 'shown', { title: win.getTitle() })
  })

  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error('window', 'preload error', {
      preloadPath,
      message: error instanceof Error ? error.message : String(error),
    })
    if (smokeMode) smokeFailure('preload-error')
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('window', 'render process gone', { reason: details.reason, exitCode: details.exitCode })
    if (smokeMode) smokeFailure(`render-process-gone:${details.reason}`)
  })

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    logger.error('window', 'did-fail-load', { code, description, url })
    if (smokeMode) smokeFailure(`did-fail-load:${code}`)
  })

  win.webContents.on('did-finish-load', () => {
    logger.info('window', 'did-finish-load', { url: win.webContents.getURL() })
  })

  loadRenderer(win).catch((error: unknown) => {
    logger.error('window', 'load renderer failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    if (smokeMode) smokeFailure('load-renderer-failed')
  })
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.mclauncher.desktop')
  applySessionSecurity()
  installAppProtocol(path.join(__dirname, '../renderer'))

  const registry = await registerModules(logger, paths.dataRoot)
  moduleIds = registry.ids
  failedModules = registry.failed

  registerIpc({
    getInfo,
    openDataDir,
    onRendererReady: handleRendererReady,
    log: logger,
  })

  if (smokeMode) {
    smokeTimer = setTimeout(() => smokeFailure('renderer handshake timeout'), 20_000)
  }

  createMainWindow()

  logger.info('app', 'ready', { modules: ['system', ...moduleIds], failedModules })
}

app.whenReady().then(bootstrap).catch((error: unknown) => {
  logger.fatal('app', 'bootstrap failed', {
    message: error instanceof Error ? error.stack ?? error.message : String(error),
  })
  if (smokeMode) smokeFailure('bootstrap-failed')
  else app.quit()
})

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})

let quitDialogOpen = false
let quitInProgress = false
let quitAction: 'stop' | null = null

function restoreLauncher(): void {
  const existing = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  if (existing) {
    existing.show()
    existing.focus()
  } else {
    createMainWindow()
  }
}

async function disposeNetWithTimeout(
  net: { dispose?: () => Promise<void> } | null,
): Promise<void> {
  if (!net?.dispose) return
  let timer: NodeJS.Timeout | null = null
  await Promise.race([
    Promise.resolve()
      .then(() => net.dispose?.())
      .catch((error) => {
        logger.warn('app', 'net dispose before quit failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn('app', 'net dispose timed out; continuing quit', { timeoutMs: 3_000 })
        resolve()
      }, 3_000)
      timer.unref?.()
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

app.on('before-quit', (event) => {
  if (quitInProgress) {
    logger.info('app', 'quit', {
      smoke: smokeMode,
      rendererReady: rendererReport !== null,
    })
    return
  }
  const launch = getService<LaunchShutdown>('launch')
  const net = getService<{
    dispose?: () => Promise<void>
    disposeSync?: () => void
  }>('net')
  const running = launch?.hasRunningSessions?.() ?? false
  if (!running) {
    event.preventDefault()
    void disposeNetWithTimeout(net).finally(() => {
      quitInProgress = true
      logger.info('app', 'quit', {
        smoke: smokeMode,
        rendererReady: rendererReport !== null,
      })
      app.quit()
    })
    return
  }

  event.preventDefault()
  if (quitDialogOpen) return
  quitDialogOpen = true
  void dialog
    .showMessageBox({
      type: 'warning',
      title: '游戏仍在运行',
      message: '退出启动器时游戏仍在运行',
      detail: '“结束游戏并退出”会先停止游戏并退出；“取消（返回启动器）”会恢复窗口，游戏与日志管道继续运行。',
      buttons: ['结束游戏并退出', '取消（返回启动器）'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then(async (response) => {
      if (response.response !== 0) {
        quitDialogOpen = false
        restoreLauncher()
        logger.info('app', 'quit cancelled; launcher kept alive, game continues')
        return
      }
      quitAction = 'stop'
      try {
        await disposeNetWithTimeout(net)
        await launch?.stopAll?.()
      } catch (error) {
        logger.warn('app', 'stopAll before quit failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
      quitInProgress = true
      quitDialogOpen = false
      logger.info('app', 'quit confirmed with running session', { action: 'stop-and-quit' })
      app.quit()
    })
    .catch((error) => {
      quitDialogOpen = false
      logger.error('app', 'quit dialog failed; restoring launcher', {
        message: error instanceof Error ? error.message : String(error),
      })
      restoreLauncher()
    })
})

app.on('will-quit', () => {
  // If an async stop could not finish, or a quit path bypassed before-quit,
  // perform a synchronous, tree-wide kill as the last line of defence.
  const launch = getService<LaunchShutdown>('launch')
  const net = getService<{ disposeSync?: () => void }>('net')
  net?.disposeSync?.()
  if (!launch?.hasRunningSessions?.()) return
  launch.stopAllSync?.()
  logger.warn('app', 'synchronous game shutdown at will-quit', {
    action: quitAction ?? 'unknown',
  })
})

app.on('child-process-gone', (_event, details) => {
  logger.error('app', 'child process gone', { type: details.type, reason: details.reason })
})

process.on('uncaughtException', (error) => {
  logger.fatal('process', 'uncaught exception', {
    message: error.stack ?? error.message,
  })
  if (smokeMode) smokeFailure('uncaught-exception')
})

process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandled rejection', {
    message: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  })
  if (smokeMode) smokeFailure('unhandled-rejection')
})
