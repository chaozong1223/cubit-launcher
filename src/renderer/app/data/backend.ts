import type { AppInfo } from '@shared/system'
import type { SkinInfo } from '@shared/skin'
import type { SdkList, SdkStartResult, SdkStopResult } from '@shared/sdk'
import type {
  MemoryRecommendation,
  PerfApplyResult,
  PerfCacheCleanResult,
  PerfCacheScan,
  PerfHardware,
  PerfProcessResult,
} from '@shared/perf'
import type {
  DiscoverResult,
  InstanceCopyFinished,
  InstanceCopyProgress,
  InstanceCopyStart,
  InstanceSummary,
  InstancePatch,
  RemoveInstanceResult,
  SetGameDirResult,
  ShareConflictStrategy,
  ShareContentSelection,
  ShareExportFinished,
  ShareExportProgress,
  ShareExportStart,
  ShareImportFinished,
  ShareImportProgress,
  ShareImportStart,
} from '@shared/instance'
import type { VersionSummary } from '@shared/version'
import type { JavaDetectResult } from '@shared/java'
import type { LaunchExitReport, LaunchPlan, LaunchState, LaunchStatus } from '@shared/launch'
import type {
  Account,
  AuthProfile,
  AuthlibInfo,
  DeviceCode,
  MicrosoftConfig,
  PollDeviceCodeResult,
} from '@shared/auth'
import type {
  BatchOperationResult,
  InstallLocalFileResult,
  ModKind,
  ModScanResult,
  ModpackExportResult,
  ModpackImportFinished,
  ModpackImportProgress,
  ModpackImportStart,
} from '@shared/mods'
import type {
  LoaderFinished,
  LoaderInstallResult,
  LoaderListResult,
  LoaderLogEvent,
  LoaderPlan,
  LoaderProgress,
  LoaderType,
} from '@shared/loader'
import type { RepairFinished, RepairProgress, RepairReport } from '@shared/repair'
import type {
  CopyInviteOutput,
  CreateRoomInput,
  EnterWorldInput,
  JoinLanWorldInput,
  JoinRoomInput,
  LanWorldsInput,
  LanWorldsOutput,
  LinkErrorInfo,
  RoomInfo,
  RoomMember,
  RoomState,
  WorldInfo,
} from '@shared/net'
import type {
  DownloadFinished,
  DownloadProgress,
  DownloadSettings,
  DownloadSettingsPatch,
  DownloadSourcesResult,
  InstallPlanSummary,
  InstallResult,
  ManifestResult,
} from '@shared/download'
import type {
  CatalogCheckInput,
  CatalogInstallInput,
  CatalogInstallResult,
  CatalogPageInput,
  CatalogPageResult,
  CatalogProject,
  CatalogSearchInput,
  CatalogSearchResult,
  CatalogUpdateCheck,
  CatalogUpdateInput,
  CatalogUpdateResult,
  CatalogVersion,
  CatalogVersionsInput,
  CurseForgeConfigPatch,
  CurseForgeConfigView,
  LinkDownloadProgress,
  LinkImportFinished,
  LinkImportJobStart,
  LinkImportProgress,
  PackLinkPlan,
} from '@shared/catalog'
import type { RendererReadyReport } from '@shared/channels'
import type {
  AssetArea,
  BackupResult,
  BatchTrashResult,
  LogEntry,
  LogLevel,
  LogSource,
  RestoreResult,
  SaveConflictStrategy,
  SaveCopyFinished,
  SaveCopyProgress,
  SaveCopyStart,
  SaveEntry,
  ScreenshotEntry,
  TrashItem,
} from '@shared/assets'
import type {
  CrashAnalysis,
  CrashExportResult,
  CrashText,
  FixAction,
  FixResult,
} from '@shared/crash'
import type {
  PickFilesRequest,
  PickFilesResult,
  PickSaveFileRequest,
  PickSaveFileResult,
} from '@shared/channels'
import { LINK_ERROR_MESSAGES } from '@shared/net'
import { channelOf } from '@shared/kernel'
import { api, hasBridge, invokeResult, IpcError, onBridge } from '../../lib/ipc'

/** A renderer-side capability that intentionally has no IPC channel yet. */
export class NotWiredError extends Error {
  readonly code = 'UI.NOT_WIRED'
  readonly feature: string
  readonly channel: string | null
  readonly reason: string

  constructor(feature: string, channel: string | null, reason = '该数据源尚未接入后端') {
    super(`${feature}尚未接入后端`)
    this.name = 'NotWiredError'
    this.feature = feature
    this.channel = channel
    this.reason = reason
  }
}

/** An error returned by main inside a Result envelope, or a bridge failure. */
export class BackendError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'BackendError'
    this.code = code
    this.retryable = retryable
  }
}

const ERROR_COPY: Record<string, string> = {
  'IPC.UNTRUSTED_SENDER': '调用来源未通过校验',
  'IPC.INVALID_INPUT': '请求参数不合法',
  'IPC.HANDLER_FAILED': '主进程处理请求时出错',
  'IPC.NOT_READY': 'preload 桥尚未就绪',
  'JAVA.NOT_FOUND': '找不到可用的 Java 运行时',
  'JAVA.VERSION_MISMATCH': '当前 Java 版本不符合此游戏版本要求',
  'JAVA.PROBE_TIMEOUT': 'Java 检测超时，安装可能已损坏',
  'AUTH.NO_ACCOUNT': '还没有启动账户',
  'AUTH.INVALID_NAME': '账户名不符合 3–16 位字母/数字/下划线规则',
  'AUTH.NOT_CONFIGURED': '微软登录尚未配置',
  'AUTH.AUTHLIB_INSECURE': 'Authlib 地址必须使用 HTTPS',
  'MS_CLIENT_ID_MISSING': '尚未配置微软应用 ID',
  'MS_AUTH_NOT_APPROVED': '微软应用尚未获得 Minecraft API 审批',
  'MS_CONFIG_INVALID': '微软应用配置格式不正确。',
  'MODS.INVALID_FILE': '不是可安装的模组/资源包文件',
  'MODS.METADATA_INVALID': '模组元数据无法读取',
  'LOADER.INSTALLER_FAILED': '加载器安装器执行失败',
  'REPAIR.VERIFY_FAILED': '实例文件校验失败',
  'CATALOG.INCOMPATIBLE': '该资源与实例不兼容',
  'CATALOG.PRERELEASE': '测试版需要显式确认',
  'CATALOG.HASH_MISMATCH': '资源文件校验失败',
  'CATALOG.NO_HASH': '资源文件缺少上游哈希，已拒绝安装',
  'CATALOG.NO_FILE': '该版本没有可下载文件',
  'CATALOG.INSTANCE_NOT_FOUND': '找不到目标实例',
  'CATALOG.MODS_UNAVAILABLE': '模组模块不可用',
  'CATALOG.FILE_NOT_FOUND': '找不到旧的模组文件',
  'CATALOG.CURRENT_FILE_REQUIRED': '无法确定要替换的旧文件',
  'CATALOG.NO_MC_ROOT': '尚未配置 Minecraft 目录',
  'CATALOG.RATE_LIMITED': 'Modrinth 请求过于频繁，请稍后再试',
  'ASSETS.INSTANCE_NOT_FOUND': '找不到目标实例',
  'ASSETS.FILE_NOT_FOUND': '文件不存在',
  'ASSETS.SAVE_EMPTY': '存档为空，未生成备份',
  'ASSETS.UNSAFE_NAME': '文件名不安全，已拒绝操作',
  'ASSETS.IMAGE_TOO_LARGE': '截图超过 8 MB，无法生成预览',
  'ASSETS.NO_LOGS': '没有可导出的日志',
  'ASSETS.INSTANCE_REQUIRED': '该操作需要先选择实例',
  'ASSETS.OPEN_FAILED': '无法打开文件或目录',
  'ASSETS.OPEN_UNAVAILABLE': '当前环境不支持打开文件或目录',
  'CRASH.INSTANCE_NOT_FOUND': '找不到崩溃报告对应的实例',
  'CRASH.INVALID_ACTION': '崩溃修复动作参数无效',
  'VERSION.NOT_FOUND': '游戏版本不存在',
  'VERSION.INHERIT_CYCLE': '版本继承链存在循环',
  'LAUNCH.EXIT_NONZERO': '游戏异常退出',
  'LAUNCH.OOM': '内存不足，游戏进程被终止',
  'NET.OFFLINE': '网络不可用，请检查连接或代理',
  'NET.HTTP_5XX': '服务器暂时不可用',
  'MODS.INCOMPATIBLE': '模组依赖不兼容',
  'FS.NO_SPACE': '磁盘空间不足',
  'INSTANCE.RUNNING': '实例正在运行，不能删除',
  'INSTANCE.DELETE_FAILED': '删除实例失败',
  'INSTANCE.RESTORE_FAILED': '恢复实例失败',
  'INSTANCE.REMOVE_DENIED': '该路径不允许删除',
  'INSTANCE.DIRECTORY_UNAVAILABLE': '目录不存在、不是文件夹或无法读取',
  'INSTANCE.CONFIG_WRITE_FAILED': '无法保存 Minecraft 目录配置',
  'INTERNAL': '发生了未预期的错。',
}

export interface UiErrorInfo {
  kind: 'not-wired' | 'error'
  title: string
  detail: string
  code?: string
  channel?: string | null
  feature?: string
  retryable: boolean
  /** Original technical message from the main process (IP details.technicalMessage). */
  technical?: string
  /** Low-level cause code such as ENOENT/EPIPE (IP details.causeCode). */
  causeCode?: string
}

export function describeError(error: unknown): UiErrorInfo {
  if (error instanceof NotWiredError) {
    return {
      kind: 'not-wired',
      title: `${error.feature}尚未接入后端`,
      detail: error.reason,
      code: error.code,
      channel: error.channel,
      feature: error.feature,
      retryable: false,
    }
  }

  if (error instanceof IpcError) {
    if (error.code === 'IPC.NOT_READY') {
      return {
        kind: 'not-wired',
      title: 'preload 桥尚未就绪。',
        detail: error.message,
        code: error.code,
        channel: 'window.mc',
        feature: 'IPC 。',
        retryable: false,
      }
    }
    return {
      kind: 'error',
      title: ERROR_COPY[error.code] ?? '操作没有完成',
      detail: error.message,
      code: error.code,
      retryable: error.retryable,
      ...(typeof error.details?.technicalMessage === 'string'
        ? { technical: error.details.technicalMessage }
        : {}),
      ...(typeof error.details?.causeCode === 'string'
        ? { causeCode: error.details.causeCode }
        : {}),
    }
  }

  if (error instanceof BackendError) {
    const lower = error.message.toLowerCase()
    if (lower.includes('no account resolver')) {
      return {
        kind: 'not-wired',
        title: '账户模块尚未接入',
      detail: '启动预览需要真实账户；在 auth 接线前，dry-run 不会生成命令行；这里不会伪造 argv。',
        code: 'AUTH.NOT_WIRED',
        channel: 'mc:auth:*',
        feature: '还没有启动账户，请先在设置中创建离线账户',
        retryable: false,
      }
    }
    if (lower.includes('minecraft directory is not configured')) {
      return {
        kind: 'not-wired',
        title: '尚未配置 Minecraft 目录',
        detail: '启动预览需要真实账户；在 auth 接线前，dry-run 不会生成命令行；这里不会伪造 argv。',
        code: 'INSTANCE.MC_ROOT_MISSING',
        channel: 'mc:instance:list',
      feature: 'Minecraft 目录',
        retryable: true,
      }
    }
    const missingFiles = /missing files before launch:\s*(\d+)/i.exec(error.message)
    if (missingFiles) {
      return {
        kind: 'error',
      title: '安装文件不完整。',
      detail: `启动预览发现缺少 ${missingFiles[1]} 个客户库/依赖/资源文件。请先在实例详情执行“校验文件并修复缺失”，或重新安装该版本。`,
        code: 'LAUNCH.MISSING_FILES',
        retryable: true,
      }
    }
    const linkCopy = LINK_ERROR_MESSAGES[error.code as keyof typeof LINK_ERROR_MESSAGES]
    return {
      kind: 'error',
      title: linkCopy ?? ERROR_COPY[error.code] ?? '操作没有完成',
      detail: error.message,
      code: error.code,
      retryable: error.retryable,
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  if (/blocked channel|preload bridge|IPC\.NOT_READY/i.test(message)) {
    return {
      kind: 'not-wired',
      title: 'IPC 通道尚未放开',
      detail: message,
      code: 'UI.NOT_WIRED',
      channel: null,
      feature: '通道',
      retryable: false,
    }
  }

  return {
    kind: 'error',
    title: '渲染层已经按设计稿落地；实例列表与启动状态需要 IPC 白名单放行后才会出现。这里不会用示例实例名或虚拟版本号填充。',
    detail: message,
    code: 'UI.UNKNOWN',
    retryable: true,
  }
}

async function invoke<T>(
  feature: string,
  channel: string,
  payload?: unknown,
): Promise<T> {
  if (!hasBridge()) {
    throw new NotWiredError(feature, 'window.mc', 'preload 桥未加载；无法读取真实数据。')
  }

  let result
  try {
    result = await invokeResult<T>(channel, payload)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/blocked channel|No handler registered|preload bridge|IPC\.NOT_READY/i.test(message)) {
      throw new NotWiredError(
        feature,
        channel,
        `通道 ${channel} 尚未由主进程注册（或 preload 未运行）。当前保留界面结构，等待 IPC 接线后再加载真实数据。`,
      )
    }
    throw new BackendError('IPC.NOT_READY', message, true)
  }

  if (!result.ok) {
    throw new BackendError(result.error.code, result.error.message, result.error.retryable)
  }
  return result.data
}

const CH = {
  instanceList: channelOf('instance', 'list'),
  instanceGet: channelOf('instance', 'get'),
  instanceUpdate: channelOf('instance', 'update'),
  instanceRemove: channelOf('instance', 'remove'),
  instanceCopyInstance: channelOf('instance', 'copyInstance'),
  instanceCancelCopy: channelOf('instance', 'cancelCopy'),
  instancePauseCopy: channelOf('instance', 'pauseCopy'),
  instanceResumeCopy: channelOf('instance', 'resumeCopy'),
  instanceCopyStatus: channelOf('instance', 'copyStatus'),
  instanceCopyResult: channelOf('instance', 'copyResult'),
  instanceExportSharePackJob: channelOf('instance', 'exportSharePackJob'),
  instanceCancelShareExport: channelOf('instance', 'cancelShareExport'),
  instanceShareExportStatus: channelOf('instance', 'shareExportStatus'),
  instanceShareExportResult: channelOf('instance', 'shareExportResult'),
  instanceImportSharePackJob: channelOf('instance', 'importSharePackJob'),
  instanceCancelShareImport: channelOf('instance', 'cancelShareImport'),
  instanceShareImportStatus: channelOf('instance', 'shareImportStatus'),
  instanceShareImportResult: channelOf('instance', 'shareImportResult'),
  instanceRestore: channelOf('instance', 'restore'),
  instanceDiscover: channelOf('instance', 'discover'),
  instanceSetGameDir: channelOf('instance', 'setGameDir'),
  instanceImport: channelOf('instance', 'import'),
  versionList: channelOf('version', 'listVersions'),
  versionInspect: channelOf('version', 'inspect'),
  javaDetect: channelOf('java', 'detect'),
  javaChoose: channelOf('java', 'choose'),
  launchStatus: channelOf('launch', 'status'),
  launchPlan: channelOf('launch', 'plan'),
  launchStart: channelOf('launch', 'start'),
  launchStop: channelOf('launch', 'stop'),
  launchLastReport: channelOf('launch', 'lastReport'),
  authList: channelOf('auth', 'list'),
  authCreateOffline: channelOf('auth', 'createOffline'),
  authCreateAuthlib: channelOf('auth', 'createAuthlib'),
  authLoginAuthlib: channelOf('auth', 'loginAuthlib'),
  authProfile: channelOf('auth', 'profile'),
  authSignoutAuthlib: channelOf('auth', 'signoutAuthlib'),
  authSelect: channelOf('auth', 'select'),
  skinGet: channelOf('skin', 'get'),
  skinImportFile: channelOf('skin', 'importFile'),
  skinImportUrl: channelOf('skin', 'importUrl'),
  skinImportFromAccount: channelOf('skin', 'importFromAccount'),
  skinRestore: channelOf('skin', 'restore'),
  sdkList: channelOf('sdk', 'list'),
  sdkStart: channelOf('sdk', 'start'),
  sdkStop: channelOf('sdk', 'stop'),
  sdkOpenFolder: channelOf('sdk', 'openFolder'),
  authBeginDeviceCode: channelOf('auth', 'beginDeviceCode'),
  authPollDeviceCode: channelOf('auth', 'pollDeviceCode'),
  authLogout: channelOf('auth', 'logout'),
  authSetAuthlib: channelOf('auth', 'setAuthlib'),
  authConfigureMicrosoft: channelOf('auth', 'configureMicrosoft'),
  authGetMicrosoftConfig: channelOf('auth', 'getMicrosoftConfig'),
  authAuthlibInfo: channelOf('auth', 'authlibInfo'),
  authEnsureAuthlib: channelOf('auth', 'ensureAuthlib'),
  modsScan: channelOf('mods', 'scan'),
  modsSetEnabled: channelOf('mods', 'setEnabled'),
  modsRemove: channelOf('mods', 'remove'),
  modsInstallLocalFile: channelOf('mods', 'installLocalFile'),
  modsAnalyzeDependencies: channelOf('mods', 'analyzeDependencies'),
  modsImportModpack: channelOf('mods', 'importModpack'),
  modsCancelImport: channelOf('mods', 'cancelImport'),
  modsPauseImport: channelOf('mods', 'pauseImport'),
  modsResumeImport: channelOf('mods', 'resumeImport'),
  modsImportStatus: channelOf('mods', 'importStatus'),
  modsImportResult: channelOf('mods', 'importResult'),
  modsExportModpack: channelOf('mods', 'exportModpack'),
  modsOpenFolder: channelOf('mods', 'openFolder'),
  catalogSearch: channelOf('catalog', 'search'),
  catalogProject: channelOf('catalog', 'project'),
  catalogVersions: channelOf('catalog', 'versions'),
  catalogInstall: channelOf('catalog', 'install'),
  catalogCheckUpdates: channelOf('catalog', 'checkUpdates'),
  catalogUpdate: channelOf('catalog', 'update'),
  catalogPageUrl: channelOf('catalog', 'pageUrl'),
  catalogOpenPage: channelOf('catalog', 'openPage'),
  catalogCurseForgeConfig: channelOf('catalog', 'getCurseForgeConfig'),  catalogUpdateCurseForgeConfig: channelOf('catalog', 'updateCurseForgeConfig'),
  catalogPlanLinkImport: channelOf('catalog', 'planLinkImport'),
  catalogStartLinkImport: channelOf('catalog', 'startLinkImport'),
  catalogCancelLinkImport: channelOf('catalog', 'cancelLinkImport'),
  catalogLinkImportStatus: channelOf('catalog', 'linkImportStatus'),
  catalogLinkImportResult: channelOf('catalog', 'linkImportResult'),
  perfHardware: channelOf('perf', 'hardware'),
  perfRecommend: channelOf('perf', 'recommend'),
  perfApply: channelOf('perf', 'apply'),
  perfProcesses: channelOf('perf', 'processes'),
  perfScanCache: channelOf('perf', 'scanCache'),
  perfCleanCache: channelOf('perf', 'cleanCache'),
  assetsListSaves: channelOf('assets', 'listSaves'),
  assetsBackupSave: channelOf('assets', 'backupSave'),
  assetsDeleteSaves: channelOf('assets', 'deleteSaves'),
  assetsCopySaveJob: channelOf('assets', 'copySaveJob'),
  assetsCancelCopySave: channelOf('assets', 'cancelCopySave'),
  assetsCopySaveStatus: channelOf('assets', 'copySaveStatus'),
  assetsCopySaveResult: channelOf('assets', 'copySaveResult'),
  assetsListScreenshots: channelOf('assets', 'listScreenshots'),
  assetsPreviewScreenshot: channelOf('assets', 'previewScreenshot'),
  assetsDeleteScreenshots: channelOf('assets', 'deleteScreenshots'),
  assetsListLogs: channelOf('assets', 'listLogs'),
  assetsQueryLogs: channelOf('assets', 'queryLogs'),
  assetsExportLogs: channelOf('assets', 'exportLogs'),
  assetsExportDiagnostics: channelOf('assets', 'exportDiagnostics'),
  assetsOpenFolder: channelOf('assets', 'openFolder'),
  assetsShowInFolder: channelOf('assets', 'showInFolder'),
  assetsOpenFile: channelOf('assets', 'openFile'),
  assetsListTrash: channelOf('assets', 'listTrash'),
  assetsRestoreTrash: channelOf('assets', 'restoreTrash'),
  assetsPurgeTrash: channelOf('assets', 'purgeTrash'),
  crashAnalyze: channelOf('crash', 'analyze'),
  crashApplyFix: channelOf('crash', 'applyFix'),
  crashExportReport: channelOf('crash', 'exportReport'),
  crashFormat: channelOf('crash', 'format'),
  loaderList: channelOf('loader', 'list'),
  loaderPlan: channelOf('loader', 'plan'),
  loaderInstall: channelOf('loader', 'install'),
  loaderCancel: channelOf('loader', 'cancel'),
  loaderStatus: channelOf('loader', 'status'),
  loaderListJobs: channelOf('loader', 'listJobs'),
  loaderVerify: channelOf('loader', 'verify'),
  loaderDryRun: channelOf('loader', 'dryRun'),
  repairScan: channelOf('repair', 'scan'),
  repairRepair: channelOf('repair', 'repair'),
  repairStatus: channelOf('repair', 'status'),
  repairReport: channelOf('repair', 'report'),
  repairCancel: channelOf('repair', 'cancel'),
  repairListJobs: channelOf('repair', 'listJobs'),
  systemPickFiles: 'mc:system:pickFiles',
  systemPickSaveFile: 'mc:system:pickSaveFile',
  downloadSources: channelOf('download', 'listSources'),
  downloadCustomFile: channelOf('download', 'downloadCustomFile'),
  downloadSettings: channelOf('download', 'getSettings'),
  downloadUpdateSettings: channelOf('download', 'updateSettings'),
  downloadManifest: channelOf('download', 'fetchManifest'),
  downloadPlan: channelOf('download', 'plan'),
  downloadInstall: channelOf('download', 'install'),
  downloadStatus: channelOf('download', 'status'),
  downloadList: channelOf('download', 'list'),
  downloadPause: channelOf('download', 'pause'),
  downloadResume: channelOf('download', 'resume'),
  downloadCancel: channelOf('download', 'cancel'),
  netStatus: channelOf('net', 'status'),
  netCreate: channelOf('net', 'create'),
  netJoin: channelOf('net', 'join'),
  netLeave: channelOf('net', 'leave'),
  netCopyInvite: channelOf('net', 'copyInvite'),
  netEnterWorld: channelOf('net', 'enterWorld'),
  netLanWorlds: channelOf('net', 'lanWorlds'),
  netJoinLanWorld: channelOf('net', 'joinLanWorld'),
  netDiagnose: channelOf('net', 'diagnose'),
} as const

export type NetStateEvent = {
  state: RoomState
  code: string | null
  error: LinkErrorInfo | null
}

export type LaunchOutputEvent = {
  sessionId: string
  line: string
}

function on<T>(channel: string, callback: (payload: T) => void): () => void {
  if (!hasBridge()) return () => undefined
  try {
    return onBridge<T>(channel, callback)
  } catch {
    return () => undefined
  }
}

export type LaunchStatusEvent = {
  instanceId: string
  state: LaunchState
  sessionId: string | null
  startedAt: number | null
  exitCode: number | null
}

export type LaunchStageEvent = {
  instanceId: string
  stage: 'precheck' | 'java' | 'args' | 'spawn'
  detail: string | null
}

export type LaunchExitedEvent = {
  sessionId: string
  exitCode: number | null
  reportId: string | null
}

export type CatalogCheckProgressEvent = {
  jobId: string
  done: number
  total: number
  currentFile: string | null
  phase: 'scan' | 'hash' | 'lookup' | 'versions' | 'compare'
}

export type CatalogInstallProgressEvent = {
  projectId: string
  versionId: string
  stage: 'resolve' | 'download' | 'verify' | 'install' | 'done'
  percent: number | null
  bytes: number
  totalBytes: number
}

export type CatalogUpdatedEvent = {
  instanceId: string
  projectId: string
  versionId: string
  recycledPath: string | null
}

export type CatalogLinkProgressEvent = LinkDownloadProgress
export type CatalogLinkFinishedEvent = LinkImportFinished

export type AssetsChangedEvent = { area: AssetArea }
export type CrashChangedEvent = { instanceId: string | null }

export interface LogQueryInput {
  instanceId?: string
  level?: LogLevel
  minLevel?: LogLevel
  search?: string
  limit?: number
  offset?: number
}

export type LogQueryResult = {
  entries: LogEntry[]
  total: number
  sources: LogSource[]
}

export interface Backend {
  system: {
    info(): Promise<AppInfo>
    version(): Promise<string>
    openDataDir(): Promise<{ opened: boolean }>
    getPathForFile(file: File): string
    pickFiles(request?: PickFilesRequest): Promise<PickFilesResult>
    pickSaveFile(request?: PickSaveFileRequest): Promise<PickSaveFileResult>
    reportReady(report: RendererReadyReport): Promise<{ ack: boolean }>
    probeBlockedChannel(): Promise<boolean>
    minimize(): Promise<{ ok: boolean }>
    maximize(): Promise<{ ok: boolean; maximized: boolean }>
    close(): Promise<{ ok: boolean }>
  }
  instances: {
    list(): Promise<InstanceSummary[]>
    get(id: string): Promise<InstanceSummary>
    update(id: string, patch: InstancePatch): Promise<InstanceSummary>
    removeInstance(id: string): Promise<RemoveInstanceResult>
    copyInstance(id: string, newName?: string, includeWorlds?: boolean): Promise<InstanceCopyStart>
    cancelCopy(jobId: string): Promise<{ cancelled: boolean }>
    pauseCopy(jobId: string): Promise<{ paused: boolean }>
    resumeCopy(jobId: string): Promise<{ resumed: boolean }>
    copyStatus(jobId: string): Promise<InstanceCopyProgress | null>
    copyResult(jobId: string): Promise<InstanceCopyFinished | null>
    subscribeCopyProgress(callback: (event: InstanceCopyProgress) => void): () => void
    subscribeCopyFinished(callback: (event: InstanceCopyFinished) => void): () => void
    exportSharePackJob(
      instanceId: string,
      outPath?: string,
      include?: Partial<ShareContentSelection>,
    ): Promise<ShareExportStart>
    cancelShareExport(jobId: string): Promise<{ cancelled: boolean }>
    shareExportStatus(jobId: string): Promise<ShareExportProgress | null>
    shareExportResult(jobId: string): Promise<ShareExportFinished | null>
    importSharePackJob(
      filePath: string,
      name?: string,
      conflict?: ShareConflictStrategy,
    ): Promise<ShareImportStart>
    cancelShareImport(jobId: string): Promise<{ cancelled: boolean }>
    shareImportStatus(jobId: string): Promise<ShareImportProgress | null>
    shareImportResult(jobId: string): Promise<ShareImportFinished | null>
    subscribeShareExportProgress(callback: (event: ShareExportProgress) => void): () => void
    subscribeShareExportFinished(callback: (event: ShareExportFinished) => void): () => void
    subscribeShareImportProgress(callback: (event: ShareImportProgress) => void): () => void
    subscribeShareImportFinished(callback: (event: ShareImportFinished) => void): () => void
    restoreInstance(trashId: string): Promise<TrashItem>
    discover(): Promise<DiscoverResult>
    setGameDir(path: string): Promise<SetGameDirResult>
    importRoot(path: string): Promise<SetGameDirResult>
    subscribeChanged(callback: () => void): () => void
  }
  versions: {
    list(mcRoot?: string): Promise<VersionSummary[]>
    inspect(versionId: string): Promise<unknown>
  }
  java: {
    detect(force?: boolean): Promise<JavaDetectResult>
    choose(requiredMajor?: number | null): Promise<unknown>
  }
  auth: {
    list(): Promise<{ accounts: Account[]; selectedId: string | null }>
    createOffline(name: string): Promise<Account>
    createAuthlib(name: string, server: string, password?: string): Promise<Account>
    loginAuthlib(name: string, password: string, server: string): Promise<Account>
    profile(id: string): Promise<AuthProfile>
    signoutAuthlib(id: string): Promise<{ ok: boolean }>
    select(id: string): Promise<{ ok: boolean }>
    beginDeviceCode(): Promise<DeviceCode>
    pollDeviceCode(flowId: string): Promise<PollDeviceCodeResult>
    logout(id: string): Promise<{ ok: boolean }>
    setAuthlib(id: string, server: string): Promise<Account>
    configureMicrosoft(input: { clientId?: string | null; tenant?: string }): Promise<MicrosoftConfig>
    getMicrosoftConfig(): Promise<MicrosoftConfig>
    authlibInfo(): Promise<AuthlibInfo>
    ensureAuthlib(): Promise<AuthlibInfo>
    subscribeChanged(callback: () => void): () => void
  }
  skin: {
    get(accountId: string): Promise<SkinInfo>
    importFile(accountId: string, filePath: string): Promise<SkinInfo>
    importUrl(accountId: string, url: string): Promise<SkinInfo>
    importFromAccount(accountId: string): Promise<SkinInfo>
    restore(accountId: string): Promise<SkinInfo>
  }
  sdk: {
    list(): Promise<SdkList>
    start(id: string, args?: string[]): Promise<SdkStartResult>
    stop(id: string): Promise<SdkStopResult>
    openFolder(): Promise<{ path: string; opened: boolean }>
  }
  launch: {
    status(instanceId: string): Promise<LaunchStatus>
    plan(instanceId: string, accountId?: string | null, world?: string | null): Promise<LaunchPlan>
    start(instanceId: string, accountId?: string | null, world?: string | null): Promise<{ sessionId: string }>
    stop(sessionId: string): Promise<{ ok: boolean }>
    lastReport(instanceId: string): Promise<LaunchExitReport | null>
    subscribeStatus(callback: (event: LaunchStatusEvent) => void): () => void
    subscribeStage(callback: (event: LaunchStageEvent) => void): () => void
    subscribeExited(callback: (event: LaunchExitedEvent) => void): () => void
  }
  mods: {
    scan(instanceId: string, kind?: ModKind): Promise<ModScanResult>
    setEnabled(instanceId: string, kind: ModKind, names: string[], enabled: boolean): Promise<BatchOperationResult>
    remove(instanceId: string, kind: ModKind, names: string[]): Promise<BatchOperationResult>
    installLocalFile(instanceId: string, path: string, kind?: ModKind): Promise<InstallLocalFileResult>
    analyzeDependencies(instanceId: string): Promise<{ issues: unknown[] }>
    importModpack(filePath: string, name?: string): Promise<ModpackImportStart>
    cancelImport(jobId: string): Promise<{ cancelled: boolean }>
    pauseImport(jobId: string): Promise<{ paused: boolean }>
    resumeImport(jobId: string): Promise<{ resumed: boolean }>
    importStatus(jobId: string): Promise<ModpackImportProgress | null>
    importResult(jobId: string): Promise<ModpackImportFinished | null>
    exportModpack(instanceId: string, outPath?: string): Promise<ModpackExportResult>
    openFolder(instanceId: string, kind: ModKind): Promise<{ path: string }>
    subscribeChanged(callback: () => void): () => void
    subscribeImportProgress(callback: (event: ModpackImportProgress) => void): () => void
    subscribeImportFinished(callback: (event: ModpackImportFinished) => void): () => void
  }
  catalog: {
    search(input: CatalogSearchInput): Promise<CatalogSearchResult>
    project(idOrSlug: string): Promise<CatalogProject>
    versions(input: CatalogVersionsInput): Promise<CatalogVersion[]>
    install(input: CatalogInstallInput): Promise<CatalogInstallResult>
    checkUpdates(input: CatalogCheckInput): Promise<CatalogUpdateCheck>
    update(input: CatalogUpdateInput): Promise<CatalogUpdateResult>
    pageUrl(input: CatalogPageInput): Promise<CatalogPageResult>
    openPage(input: CatalogPageInput): Promise<CatalogPageResult>
    getCurseForgeConfig(): Promise<CurseForgeConfigView>
    updateCurseForgeConfig(input: CurseForgeConfigPatch): Promise<CurseForgeConfigView>
    planLinkImport(link: string): Promise<PackLinkPlan>
    startLinkImport(planId: string): Promise<LinkImportJobStart>
    cancelLinkImport(jobId: string): Promise<{ cancelled: boolean }>
    linkImportStatus(jobId: string): Promise<LinkImportProgress | null>
    linkImportResult(jobId: string): Promise<LinkImportFinished | null>
    subscribeCheckProgress(callback: (event: CatalogCheckProgressEvent) => void): () => void
    subscribeInstallProgress(callback: (event: CatalogInstallProgressEvent) => void): () => void
    subscribeUpdated(callback: (event: CatalogUpdatedEvent) => void): () => void
    subscribeLinkProgress(callback: (event: CatalogLinkProgressEvent) => void): () => void
    subscribeLinkFinished(callback: (event: CatalogLinkFinishedEvent) => void): () => void
  }
  assets: {
    listSaves(instanceId: string): Promise<{ gameDir: string; saves: SaveEntry[] }>
    backupSave(instanceId: string, name: string, outPath?: string): Promise<BackupResult>
    deleteSaves(instanceId: string, names: string[]): Promise<BatchTrashResult>
    copySaveJob(
      instanceId: string,
      name: string,
      targetInstanceId: string,
      targetName?: string,
      conflict?: SaveConflictStrategy,
    ): Promise<SaveCopyStart>
    cancelCopySave(jobId: string): Promise<{ cancelled: boolean }>
    copySaveStatus(jobId: string): Promise<SaveCopyProgress | null>
    copySaveResult(jobId: string): Promise<SaveCopyFinished | null>
    subscribeCopySaveProgress(callback: (event: SaveCopyProgress) => void): () => void
    subscribeCopySaveFinished(callback: (event: SaveCopyFinished) => void): () => void
    listScreenshots(instanceId: string): Promise<{ gameDir: string; screenshots: ScreenshotEntry[] }>
    previewScreenshot(instanceId: string, name: string): Promise<{ dataUrl: string; mime: string; size: number }>
    deleteScreenshots(instanceId: string, names: string[]): Promise<BatchTrashResult>
    listLogs(instanceId?: string): Promise<{ sources: LogSource[] }>
    queryLogs(input: LogQueryInput): Promise<LogQueryResult>
    exportLogs(instanceId?: string, outPath?: string): Promise<BackupResult>
    exportDiagnostics(instanceId?: string, outPath?: string): Promise<BackupResult>
    openFolder(instanceId: string | undefined, area: AssetArea): Promise<{ path: string }>
    showInFolder(instanceId: string, kind: 'save' | 'screenshot', name: string): Promise<{ path: string }>
    openFile(instanceId: string, kind: 'save' | 'screenshot', name: string): Promise<{ ok: boolean }>
    listTrash(): Promise<{ items: TrashItem[] }>
    restoreTrash(ids?: string[]): Promise<RestoreResult>
    purgeTrash(ids?: string[]): Promise<{ purged: string[]; failed: Array<{ id: string; message: string }> }>
    subscribeChanged(callback: (event: AssetsChangedEvent) => void): () => void
  }
  perf: {
    hardware(): Promise<PerfHardware>
    recommend(input: { instanceId?: string; modCount?: number }): Promise<MemoryRecommendation>
    apply(input: { instanceId: string; mb?: number }): Promise<PerfApplyResult>
    processes(): Promise<PerfProcessResult>
    scanCache(): Promise<PerfCacheScan>
    cleanCache(input: { categories?: string[] }): Promise<PerfCacheCleanResult>
  }
  crash: {
    analyze(input: {
      instanceId?: string
      exitCode?: number | null
      logText?: string
      maxLines?: number
    }): Promise<CrashAnalysis>
    applyFix(instanceId: string, action: FixAction): Promise<FixResult>
    exportReport(analysis: CrashAnalysis, outPath?: string): Promise<CrashExportResult>
    format(analysis: CrashAnalysis): Promise<CrashText>
    subscribeChanged(callback: (event: CrashChangedEvent) => void): () => void
  }
  loader: {
    list(type: LoaderType, mcVersion: string, force?: boolean): Promise<LoaderListResult>
    plan(type: LoaderType, mcVersion: string, loaderVersion?: string): Promise<LoaderPlan>
    install(input: {
      type: LoaderType
      mcVersion: string
      loaderVersion?: string
      javaPath?: string
      confirmSha1?: string | null
      allowUnverifiedInstaller?: boolean
    }): Promise<LoaderInstallResult>
    cancel(jobId: string): Promise<{ cancelled: boolean }>
    status(jobId: string): Promise<LoaderProgress | null>
    listJobs(): Promise<LoaderProgress[]>
    verify(versionId: string): Promise<unknown>
    dryRun(versionId: string, javaPath?: string): Promise<unknown>
    subscribeProgress(callback: (progress: LoaderProgress) => void): () => void
    subscribeLog(callback: (event: LoaderLogEvent) => void): () => void
    subscribeFinished(callback: (event: LoaderFinished) => void): () => void
  }
  repair: {
    scan(versionId: string, verify?: 'hash' | 'size'): Promise<{ jobId: string }>
    repair(versionId: string, verify?: 'hash' | 'size'): Promise<{ jobId: string }>
    status(jobId: string): Promise<RepairProgress | null>
    report(jobId: string): Promise<RepairReport | null>
    cancel(jobId: string): Promise<{ cancelled: boolean }>
    listJobs(): Promise<RepairProgress[]>
    subscribeScanProgress(callback: (progress: RepairProgress) => void): () => void
    subscribeScanFinished(callback: (event: RepairFinished) => void): () => void
    subscribeRepairProgress(callback: (progress: RepairProgress) => void): () => void
    subscribeRepairFinished(callback: (event: RepairFinished) => void): () => void
  }
  downloads: {
    channel: 'mc:download:list / mc:download:evt:progress'
    downloadCustomFile(input: { url: string; saveDir: string; fileName?: string }): Promise<{ path: string; bytes: number; fileName: string }>
    sources(): Promise<DownloadSourcesResult>
    settings(): Promise<DownloadSettings>
    updateSettings(patch: DownloadSettingsPatch): Promise<DownloadSettings>
    manifest(force?: boolean): Promise<ManifestResult>
    plan(versionId: string): Promise<InstallPlanSummary>
    install(versionId: string): Promise<InstallResult>
    status(jobId: string): Promise<DownloadProgress | null>
    list(): Promise<DownloadProgress[]>
    pause(jobId: string): Promise<{ paused: boolean }>
    resume(jobId: string): Promise<{ resumed: boolean }>
    cancel(jobId: string): Promise<{ cancelled: boolean }>
    subscribeProgress(callback: (progress: DownloadProgress) => void): () => void
    subscribeFinished(callback: (finished: DownloadFinished) => void): () => void
  }
  link: {
    channel: string
    status(): Promise<RoomInfo | null>
    create(input: CreateRoomInput): Promise<RoomInfo>
    join(input: JoinRoomInput): Promise<RoomInfo>
    leave(): Promise<{ ok: boolean }>
    copyInvite(): Promise<CopyInviteOutput>
    enterWorld(input: EnterWorldInput): Promise<{ sessionId: string; server: { host: string; port: number } }>
    lanWorlds(input?: LanWorldsInput): Promise<LanWorldsOutput>
    joinLanWorld(input: JoinLanWorldInput): Promise<{ sessionId: string; server: { host: string; port: number } }>
    diagnose(): Promise<{ json: string }>
    subscribeState(callback: (event: NetStateEvent) => void): () => void
    subscribeMembers(callback: (members: RoomMember[]) => void): () => void
    subscribeWorld(callback: (world: WorldInfo) => void): () => void
    subscribeError(callback: (error: LinkErrorInfo) => void): () => void
    subscribeLanWorlds(callback: (event: LanWorldsOutput) => void): () => void
  }
  settings: {
    load(): Promise<unknown>
    channel: string
  }
  logs: {
    query(): Promise<unknown[]>
    channel: string
    subscribeLaunchOutput(callback: (event: LaunchOutputEvent) => void): () => void
  }
}

export const ipcBackend: Backend = {
  system: {
    info: () => api.app.info(),
    version: () => api.app.version(),
    openDataDir: () => api.app.openDataDir(),
    getPathForFile: (file) => {
      try {
        return window.mc.system?.getPathForFile(file) ?? ''
      } catch {
        return ''
      }
    },
    pickFiles: (request = {}) =>
      invoke<PickFilesResult>('选择文件', CH.systemPickFiles, request),
    pickSaveFile: (request = {}) =>
      invoke<PickSaveFileResult>('选择保存位置', CH.systemPickSaveFile, request),
    reportReady: (report) => api.app.reportRendererReady(report),
    probeBlockedChannel: () => api.probeBlockedChannel(),
    minimize: () => api.window.minimize(),
    maximize: () => api.window.maximize(),
    close: () => api.window.close(),
  },
  instances: {
    list: () => invoke<InstanceSummary[]>('实例列表', CH.instanceList),
    get: (id) => invoke<InstanceSummary>('实例详情', CH.instanceGet, { id }),
    update: (id, patch) => invoke<InstanceSummary>('更新实例', CH.instanceUpdate, { id, patch }),
    removeInstance: (id) => invoke<RemoveInstanceResult>('删除实例到回收站', CH.instanceRemove, { id }),
    copyInstance: (id, newName, includeWorlds) => invoke<InstanceCopyStart>('复制实例（后台任务）', CH.instanceCopyInstance, { id, ...(newName ? { newName } : {}), ...(includeWorlds === undefined ? {} : { includeWorlds }) }),
    cancelCopy: (jobId) => invoke<{ cancelled: boolean }>('取消复制实例', CH.instanceCancelCopy, { jobId }),
    pauseCopy: (jobId) => invoke<{ paused: boolean }>('暂停复制实例', CH.instancePauseCopy, { jobId }),
    resumeCopy: (jobId) => invoke<{ resumed: boolean }>('继续复制实例', CH.instanceResumeCopy, { jobId }),
    copyStatus: (jobId) => invoke<InstanceCopyProgress | null>('复制任务状态', CH.instanceCopyStatus, { jobId }),
    copyResult: (jobId) => invoke<InstanceCopyFinished | null>('复制任务结果', CH.instanceCopyResult, { jobId }),
    subscribeCopyProgress: (callback) => on('mc:instance:evt:copyProgress', callback),
    subscribeCopyFinished: (callback) => on('mc:instance:evt:copyFinished', callback),
    exportSharePackJob: (instanceId, outPath, include) =>
      invoke<ShareExportStart>('导出实例分享包', CH.instanceExportSharePackJob, {
        instanceId,
        ...(outPath ? { outPath } : {}),
        ...(include ? { include } : {}),
      }),
    cancelShareExport: (jobId) =>
      invoke<{ cancelled: boolean }>('取消导出分享包', CH.instanceCancelShareExport, { jobId }),
    shareExportStatus: (jobId) =>
      invoke<ShareExportProgress | null>('分享包导出状态', CH.instanceShareExportStatus, { jobId }),
    shareExportResult: (jobId) =>
      invoke<ShareExportFinished | null>('分享包导出结果', CH.instanceShareExportResult, { jobId }),
    importSharePackJob: (filePath, name, conflict) =>
      invoke<ShareImportStart>('导入实例分享包', CH.instanceImportSharePackJob, {
        filePath,
        ...(name ? { name } : {}),
        ...(conflict ? { conflict } : {}),
      }),
    cancelShareImport: (jobId) =>
      invoke<{ cancelled: boolean }>('取消导入分享包', CH.instanceCancelShareImport, { jobId }),
    shareImportStatus: (jobId) =>
      invoke<ShareImportProgress | null>('分享包导入状态', CH.instanceShareImportStatus, { jobId }),
    shareImportResult: (jobId) =>
      invoke<ShareImportFinished | null>('分享包导入结果', CH.instanceShareImportResult, { jobId }),
    subscribeShareExportProgress: (callback) => on('mc:instance:evt:shareExportProgress', callback),
    subscribeShareExportFinished: (callback) => on('mc:instance:evt:shareExportFinished', callback),
    subscribeShareImportProgress: (callback) => on('mc:instance:evt:shareImportProgress', callback),
    subscribeShareImportFinished: (callback) => on('mc:instance:evt:shareImportFinished', callback),
    restoreInstance: (trashId) => invoke<TrashItem>('从回收站恢复实例', CH.instanceRestore, { trashId }),
    discover: () => invoke<DiscoverResult>('发现 Minecraft 目录', CH.instanceDiscover),
    setGameDir: (path) => invoke<SetGameDirResult>('设置 Minecraft 目录', CH.instanceSetGameDir, { path }),
    importRoot: (path) => invoke<SetGameDirResult>('导入 Minecraft 目录', CH.instanceImport, { path }),
    subscribeChanged: (callback) => on('mc:instance:evt:changed', callback),
  },
  versions: {
    list: (mcRoot) => invoke<VersionSummary[]>('版本清单', CH.versionList, mcRoot ? { mcRoot } : {}),
    inspect: (versionId) => invoke('版本详情', CH.versionInspect, { versionId }),
  },
  java: {
    detect: (force = false) => invoke<JavaDetectResult>('Java 检测', CH.javaDetect, { force }),
    choose: (requiredMajor) => invoke('Java 选择', CH.javaChoose, { requiredMajor: requiredMajor ?? null }),
  },
  auth: {
    list: () => invoke('账户列表', CH.authList),
    createOffline: (name) => invoke<Account>('创建离线账户', CH.authCreateOffline, { name }),
    createAuthlib: (name, server, password) =>
      invoke<Account>('创建 Authlib 账户', CH.authCreateAuthlib, { name, server, ...(password ? { password } : {}) }),
    loginAuthlib: (name, password, server) =>
      invoke<Account>('登录 Authlib 账户', CH.authLoginAuthlib, { name, password, server }),
    profile: (id) => invoke<AuthProfile>('账户已创建并选中；启动时会注入 authlib-injector。', CH.authProfile, { id }),
    signoutAuthlib: (id) => invoke<{ ok: boolean }>('退出 Authlib 登录', CH.authSignoutAuthlib, { id }),
    select: (id) => invoke<{ ok: boolean }>('选择账户', CH.authSelect, { id }),
    beginDeviceCode: () => invoke<DeviceCode>('回收站与原始目录分离；恢复前会检查目标路径。若原位置已有同名文件，后端会报告冲突并保持两边都不被覆盖。需要清理磁盘时请手动处理 dataRoot/trash。', CH.authBeginDeviceCode),
    pollDeviceCode: (flowId) => invoke<PollDeviceCodeResult>('退出 Authlib 登录', CH.authPollDeviceCode, { flowId }),
    logout: (id) => invoke<{ ok: boolean }>('退出账户', CH.authLogout, { id }),
    setAuthlib: (id, server) => invoke<Account>('更新 Authlib 地址', CH.authSetAuthlib, { id, server }),
    configureMicrosoft: (input) => invoke<MicrosoftConfig>('保存后会用新的 dry-run 参数刷新预览。JVM 输入框只代表实例自定义参数，启动器默认参数仍由启动链生成。', CH.authConfigureMicrosoft, input),
    getMicrosoftConfig: () => invoke<MicrosoftConfig>('微软登录配置', CH.authGetMicrosoftConfig),
    authlibInfo: () => invoke<AuthlibInfo>('Authlib 信息', CH.authAuthlibInfo),
    ensureAuthlib: () => invoke<AuthlibInfo>('准备 Authlib', CH.authEnsureAuthlib),
    subscribeChanged: (callback) => on('mc:auth:evt:changed', callback),
  },
  skin: {
    get: (accountId) => invoke<SkinInfo>('读取本地皮肤', CH.skinGet, { accountId }),
    importFile: (accountId, filePath) =>
      invoke<SkinInfo>('导入本地皮肤文件', CH.skinImportFile, { accountId, filePath }),
    importUrl: (accountId, url) =>
      invoke<SkinInfo>('从链接导入皮肤', CH.skinImportUrl, { accountId, url }),
    importFromAccount: (accountId) =>
      invoke<SkinInfo>('导入账户皮肤站皮肤', CH.skinImportFromAccount, { accountId }),
    restore: (accountId) => invoke<SkinInfo>('恢复默认皮肤', CH.skinRestore, { accountId }),
  },
  sdk: {
    list: () => invoke<SdkList>('第三方联机 SDK 清单', CH.sdkList),
    start: (id, args) =>
      invoke<SdkStartResult>('启动第三方联机 SDK', CH.sdkStart, { id, ...(args ? { args } : {}) }),
    stop: (id) => invoke<SdkStopResult>('停止第三方联机 SDK', CH.sdkStop, { id }),
    openFolder: () => invoke<{ path: string; opened: boolean }>('打开第三方联机 SDK 目录', CH.sdkOpenFolder),
  },
  launch: {
    status: (instanceId) => invoke<LaunchStatus>('启动状态', CH.launchStatus, { instanceId }),
    plan: (instanceId, accountId = null, world = null) =>
      invoke<LaunchPlan>('启动参数预览', CH.launchPlan, {
        instanceId,
        accountId,
        server: null,
        world,
        dryRun: true,
      }),
    start: (instanceId, accountId = null, world = null) =>
      invoke<{ sessionId: string }>('启动游戏', CH.launchStart, {
        instanceId,
        accountId,
        server: null,
        world,
      }),
    stop: (sessionId) => invoke<{ ok: boolean }>('结束游戏', CH.launchStop, { sessionId }),
    lastReport: (instanceId) =>
      invoke<LaunchExitReport | null>('最近启动报告', CH.launchLastReport, { instanceId }),
    subscribeStatus: (callback) => on('mc:launch:evt:status', callback),
    subscribeStage: (callback) => on('mc:launch:evt:stage', callback),
    subscribeExited: (callback) => on('mc:launch:evt:exited', callback),
  },
  mods: {
    scan: (instanceId, kind) => invoke<ModScanResult>('模组更新检查需要实例的已装 mods 目录和 SHA-1 文件；没有目标实例时不会发起网络请求。', CH.modsScan, { instanceId, ...(kind ? { kind } : {}) }),
    setEnabled: (instanceId, kind, names, enabled) =>
      invoke<BatchOperationResult>('模组批量启用', CH.modsSetEnabled, { instanceId, kind, names, enabled }),
    remove: (instanceId, kind, names) =>
      invoke<BatchOperationResult>('模组批量删除', CH.modsRemove, { instanceId, kind, names }),
    installLocalFile: (instanceId, path, kind) =>
      invoke<InstallLocalFileResult>('安装一个 Minecraft 版本，或导入现有整合包。安装/导入后端接入后会出现在这里。', CH.modsInstallLocalFile, { instanceId, path, ...(kind ? { kind } : {}) }),
    analyzeDependencies: (instanceId) =>
      invoke<{ issues: unknown[] }>('模组依赖分析', CH.modsAnalyzeDependencies, { instanceId }),
    importModpack: (filePath, name) =>
      invoke<ModpackImportStart>('导入整合包（后台任务）', CH.modsImportModpack, { filePath, ...(name ? { name } : {}) }),
    cancelImport: (jobId) => invoke<{ cancelled: boolean }>('取消整合包导入', CH.modsCancelImport, { jobId }),
    pauseImport: (jobId) => invoke<{ paused: boolean }>('暂停整合包导入', CH.modsPauseImport, { jobId }),
    resumeImport: (jobId) => invoke<{ resumed: boolean }>('继续整合包导入', CH.modsResumeImport, { jobId }),
    importStatus: (jobId) => invoke<ModpackImportProgress | null>('导入任务状态', CH.modsImportStatus, { jobId }),
    importResult: (jobId) => invoke<ModpackImportFinished | null>('导入任务结果', CH.modsImportResult, { jobId }),
    subscribeImportProgress: (callback) => on('mc:mods:evt:importProgress', callback),
    subscribeImportFinished: (callback) => on('mc:mods:evt:importFinished', callback),
    exportModpack: (instanceId, outPath) =>
      invoke<ModpackExportResult>('导出整合。', CH.modsExportModpack, { instanceId, ...(outPath ? { outPath } : {}) }),
    openFolder: (instanceId, kind) =>
      invoke<{ path: string }>('打开模组目录', CH.modsOpenFolder, { instanceId, kind }),
    subscribeChanged: (callback) => on('mc:mods:evt:changed', callback),
  },
  catalog: {
    search: (input) => invoke<CatalogSearchResult>('资源库搜。', CH.catalogSearch, input),
    project: (idOrSlug) => invoke<CatalogProject>('资源库项目详情', CH.catalogProject, { idOrSlug }),
    versions: (input) => invoke<CatalogVersion[]>('资源库版本列表', CH.catalogVersions, input),
    install: (input) => invoke<CatalogInstallResult>('安装一个 Minecraft 版本，或导入现有整合包。安装/导入后端接入后会出现在这里。', CH.catalogInstall, input),
    checkUpdates: (input) => invoke<CatalogUpdateCheck>('模组更新检查需要实例的已装 mods 目录和 SHA-1 文件；没有目标实例时不会发起网络请求。', CH.catalogCheckUpdates, input),
    update: (input) => invoke<CatalogUpdateResult>('更新模组', CH.catalogUpdate, input),
    pageUrl: (input) => invoke<CatalogPageResult>('资源项目。', CH.catalogPageUrl, input),
    openPage: (input) => invoke<CatalogPageResult>('打开资源项目。', CH.catalogOpenPage, input),
    getCurseForgeConfig: () =>
      invoke<CurseForgeConfigView>('CurseForge 设置', CH.catalogCurseForgeConfig),
    updateCurseForgeConfig: (input) =>
      invoke<CurseForgeConfigView>('保存 CurseForge 设置', CH.catalogUpdateCurseForgeConfig, input),
    planLinkImport: (link) =>
      invoke<PackLinkPlan>('解析整合包链接', CH.catalogPlanLinkImport, { link }),
    startLinkImport: (planId) =>
      invoke<LinkImportJobStart>('确认导入整合包', CH.catalogStartLinkImport, { planId, confirm: true }),
    cancelLinkImport: (jobId) =>
      invoke<{ cancelled: boolean }>('取消链接导入', CH.catalogCancelLinkImport, { jobId }),
    linkImportStatus: (jobId) =>
      invoke<LinkImportProgress | null>('链接导入状态', CH.catalogLinkImportStatus, { jobId }),
    linkImportResult: (jobId) =>
      invoke<LinkImportFinished | null>('链接导入结果', CH.catalogLinkImportResult, { jobId }),
    subscribeCheckProgress: (callback) => on('mc:catalog:evt:checkProgress', callback),
    subscribeInstallProgress: (callback) => on('mc:catalog:evt:installProgress', callback),
    subscribeUpdated: (callback) => on('mc:catalog:evt:updated', callback),
    subscribeLinkProgress: (callback) => on('mc:catalog:evt:linkDownloadProgress', callback),
    subscribeLinkFinished: (callback) => on('mc:catalog:evt:linkImportFinished', callback),
  },
  assets: {
    listSaves: (instanceId) =>
      invoke<{ gameDir: string; saves: SaveEntry[] }>('存档列表', CH.assetsListSaves, { instanceId }),
    backupSave: (instanceId, name, outPath) =>
      invoke<BackupResult>('备份存档', CH.assetsBackupSave, { instanceId, name, ...(outPath ? { outPath } : {}) }),
    deleteSaves: (instanceId, names) =>
      invoke<BatchTrashResult>('删除存档到回收站', CH.assetsDeleteSaves, { instanceId, names }),
    copySaveJob: (instanceId, name, targetInstanceId, targetName, conflict) =>
      invoke<SaveCopyStart>('复制存档到其他版本', CH.assetsCopySaveJob, {
        instanceId,
        name,
        targetInstanceId,
        ...(targetName ? { targetName } : {}),
        ...(conflict ? { conflict } : {}),
      }),
    cancelCopySave: (jobId) =>
      invoke<{ cancelled: boolean }>('取消复制存档', CH.assetsCancelCopySave, { jobId }),
    copySaveStatus: (jobId) =>
      invoke<SaveCopyProgress | null>('存档复制状态', CH.assetsCopySaveStatus, { jobId }),
    copySaveResult: (jobId) =>
      invoke<SaveCopyFinished | null>('存档复制结果', CH.assetsCopySaveResult, { jobId }),
    subscribeCopySaveProgress: (callback) => on('mc:assets:evt:copySaveProgress', callback),
    subscribeCopySaveFinished: (callback) => on('mc:assets:evt:copySaveFinished', callback),
    listScreenshots: (instanceId) =>
      invoke<{ gameDir: string; screenshots: ScreenshotEntry[] }>('进入「局域网世界」（LAN 世界）列表', CH.assetsListScreenshots, { instanceId }),
    previewScreenshot: (instanceId, name) =>
      invoke<{ dataUrl: string; mime: string; size: number }>('文件 ${result.downloaded} 新 / ${result.skipped} 跳过 · ${evidence}${warnings.length ?', CH.assetsPreviewScreenshot, { instanceId, name }),
    deleteScreenshots: (instanceId, names) =>
      invoke<BatchTrashResult>('删除所选 ${selected.size} 个${meta.title}文件？此操作不可撤销。', CH.assetsDeleteScreenshots, { instanceId, names }),
    listLogs: (instanceId) =>
      invoke<{ sources: LogSource[] }>('日志来源', CH.assetsListLogs, instanceId ? { instanceId } : {}),
    queryLogs: (input) => invoke<LogQueryResult>('查看完整 NOTICE', CH.assetsQueryLogs, input),
    exportLogs: (instanceId, outPath) =>
      invoke<BackupResult>('导出日志', CH.assetsExportLogs, {
        ...(instanceId ? { instanceId } : {}),
        ...(outPath ? { outPath } : {}),
      }),
    exportDiagnostics: (instanceId, outPath) =>
      invoke<BackupResult>('导出诊断。', CH.assetsExportDiagnostics, {
        ...(instanceId ? { instanceId } : {}),
        ...(outPath ? { outPath } : {}),
      }),
    openFolder: (instanceId, area) =>
      invoke<{ path: string }>('打开资源项目页', CH.assetsOpenFolder, {
        ...(instanceId ? { instanceId } : {}),
        area,
      }),
    showInFolder: (instanceId, kind, name) =>
      invoke<{ path: string }>('在文件夹中显示', CH.assetsShowInFolder, { instanceId, kind, name }),
    openFile: (instanceId, kind, name) =>
      invoke<{ ok: boolean }>('打开文件', CH.assetsOpenFile, { instanceId, kind, name }),
    listTrash: () => invoke<{ items: TrashItem[] }>('回收站列。', CH.assetsListTrash),
    restoreTrash: (ids) =>
      invoke<RestoreResult>('恢复实例失败', CH.assetsRestoreTrash, ids ? { ids } : {}),
    purgeTrash: (ids) =>
      invoke<{ purged: string[]; failed: Array<{ id: string; message: string }> }>('永久删除失败', CH.assetsPurgeTrash, ids ? { ids } : {}),
    subscribeChanged: (callback) => on('mc:assets:evt:changed', callback),
  },
  perf: {
    hardware: () => invoke<PerfHardware>('性能面板硬件信息', CH.perfHardware),
    recommend: (input) => invoke<MemoryRecommendation>('内存推荐', CH.perfRecommend, input),
    apply: (input) => invoke<PerfApplyResult>('应用内存设置', CH.perfApply, input),
    processes: () => invoke<PerfProcessResult>('游戏进程占用', CH.perfProcesses),
    scanCache: () => invoke<PerfCacheScan>('缓存扫描（只读）', CH.perfScanCache),
    cleanCache: (input) => invoke<PerfCacheCleanResult>('清理白名单缓存', CH.perfCleanCache, input),
  },
  crash: {
    analyze: (input) => invoke<CrashAnalysis>('崩溃分析', CH.crashAnalyze, input),
    applyFix: (instanceId, action) =>
      invoke<FixResult>('应用崩溃修复', CH.crashApplyFix, { instanceId, action }),
    exportReport: (analysis, outPath) =>
      invoke<CrashExportResult>('导出崩溃报告', CH.crashExportReport, {
        analysis,
        ...(outPath ? { outPath } : {}),
      }),
    format: (analysis) => invoke<CrashText>('格式化崩溃报。', CH.crashFormat, { analysis }),
    subscribeChanged: (callback) => on('mc:crash:evt:changed', callback),
  },
  loader: {
    list: (type, mcVersion, force = false) =>
      invoke<LoaderListResult>('加载器版本清单', CH.loaderList, { type, mcVersion, force }),
    plan: (type, mcVersion, loaderVersion) =>
      invoke<LoaderPlan>('加载器安装器执行失败', CH.loaderPlan, { type, mcVersion, ...(loaderVersion ? { loaderVersion } : {}) }),
    install: (input) => invoke<LoaderInstallResult>('安装一个 Minecraft 版本，或导入现有整合包。安装/导入后端接入后会出现在这里。', CH.loaderInstall, input),
    cancel: (jobId) => invoke<{ cancelled: boolean }>('取消加载器安。', CH.loaderCancel, { jobId }),
    status: (jobId) => invoke<LoaderProgress | null>('加载器任务状。', CH.loaderStatus, { jobId }),
    listJobs: () => invoke<LoaderProgress[]>('加载器任务列。', CH.loaderListJobs),
    verify: (versionId) => invoke('加载器校。', CH.loaderVerify, { versionId }),
    dryRun: (versionId, javaPath) =>
      invoke('加载器已按清单安装；若启动失败，请到实例详情执行校验', CH.loaderDryRun, { versionId, ...(javaPath ? { javaPath } : {}) }),
    subscribeProgress: (callback) => on('mc:loader:evt:progress', callback),
    subscribeLog: (callback) => on('mc:loader:evt:log', callback),
    subscribeFinished: (callback) => on('mc:loader:evt:finished', callback),
  },
  repair: {
    scan: (versionId, verify = 'hash') => invoke<{ jobId: string }>('校验实例', CH.repairScan, { versionId, verify }),
    repair: (versionId, verify = 'hash') => invoke<{ jobId: string }>('修复实例', CH.repairRepair, { versionId, verify }),
    status: (jobId) => invoke<RepairProgress | null>('修复状态', CH.repairStatus, { jobId }),
    report: (jobId) => invoke<RepairReport | null>('修复报告', CH.repairReport, { jobId }),
    cancel: (jobId) => invoke<{ cancelled: boolean }>('取消加载器安装', CH.repairCancel, { jobId }),
    listJobs: () => invoke<RepairProgress[]>('修复任务列表', CH.repairListJobs),
    subscribeScanProgress: (callback) => on('mc:repair:evt:scanProgress', callback),
    subscribeScanFinished: (callback) => on('mc:repair:evt:scanFinished', callback),
    subscribeRepairProgress: (callback) => on('mc:repair:evt:repairProgress', callback),
    subscribeRepairFinished: (callback) => on('mc:repair:evt:repairFinished', callback),
  },
  downloads: {
    channel: 'mc:download:list / mc:download:evt:progress',
    downloadCustomFile: (input) => invoke<{ path: string; bytes: number; fileName: string }>('下载自定义文件', CH.downloadCustomFile, input),
    sources: () => invoke<DownloadSourcesResult>('下载。', CH.downloadSources),
    settings: () => invoke<DownloadSettings>('下载设置', CH.downloadSettings),
    updateSettings: (patch) => invoke<DownloadSettings>('保存下载设置', CH.downloadUpdateSettings, patch),
    manifest: (force = false) => invoke<ManifestResult>('版本清单', CH.downloadManifest, { force }),
    plan: (versionId) => invoke<InstallPlanSummary>('安装一个 Minecraft 版本，或导入现有整合包。安装/导入后端接入后会出现在这里。', CH.downloadPlan, { versionId, verifyExisting: false }),
    install: (versionId) => invoke<InstallResult>('安装一个 Minecraft 版本，或导入现有整合包。安装/导入后端接入后会出现在这里。', CH.downloadInstall, { versionId, verifyExisting: 'size' }),
    status: (jobId) => invoke<DownloadProgress | null>('下载任务状态', CH.downloadStatus, { jobId }),
    list: () => invoke<DownloadProgress[]>('下载任务', CH.downloadList),
    pause: (jobId) => invoke<{ paused: boolean }>('暂停下载', CH.downloadPause, { jobId }),
    resume: (jobId) => invoke<{ resumed: boolean }>('继续下载', CH.downloadResume, { jobId }),
    cancel: (jobId) => invoke<{ cancelled: boolean }>('取消下载', CH.downloadCancel, { jobId }),
    subscribeProgress: (callback) => on('mc:download:evt:progress', callback),
    subscribeFinished: (callback) => on('mc:download:evt:finished', callback),
  },
  link: {
    channel: 'mc:net:status / mc:net:evt:state',
    status: () => invoke<RoomInfo | null>('联机状态', CH.netStatus),
    create: (input) => invoke<RoomInfo>('创建房间', CH.netCreate, input),
    join: (input) => invoke<RoomInfo>('加入房间', CH.netJoin, input),
    leave: () => invoke<{ ok: boolean }>('离开房间', CH.netLeave),
    copyInvite: () => invoke<CopyInviteOutput>('复制回收站路径', CH.netCopyInvite),
    enterWorld: (input) =>
      invoke<{ sessionId: string; server: { host: string; port: number } }>('进入世界', CH.netEnterWorld, input),
    lanWorlds: (input) => invoke<LanWorldsOutput>('发现 modrinth.index.json，但无法解析：${error instanceof Error ? error.message : String(er', CH.netLanWorlds, input ?? {}),
    joinLanWorld: (input) =>
      invoke<{ sessionId: string; server: { host: string; port: number } }>('加入前需要可启动的实例；当前没有选择。', CH.netJoinLanWorld, input),
    diagnose: () => invoke<{ json: string }>('联机诊断', CH.netDiagnose),
    subscribeState: (callback) => on('mc:net:evt:state', callback),
    subscribeMembers: (callback) => on('mc:net:evt:members', callback),
    subscribeWorld: (callback) => on('mc:net:evt:world', callback),
    subscribeError: (callback) => on('mc:net:evt:error', callback),
    subscribeLanWorlds: (callback) => on('mc:net:evt:lanWorlds', callback),
  },
  settings: {
    channel: 'mc:store:settings',
    load: async () => {
      throw new NotWiredError(
        '设置数据',
        'mc:store:settings',
        '设置/store 契约尚未交付；本页保留控件与本地设置，不写入示例值。',
      )
    },
  },
  logs: {
    channel: 'mc:log:query / mc:launch:evt:output',
    query: async () => {
      throw new NotWiredError(
        '日志查询',
        'mc:log:query',
        'log 模块的查询通道尚未接入；已接入 launch:evt:output 的实时输出（启动后会显示真实行）。',
      )
    },
    subscribeLaunchOutput: (callback) => on('mc:launch:evt:output', callback),
  },
}