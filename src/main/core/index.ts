/**
 * Launch-domain kernel (Electron free).
 *
 * Modules under `src/main/modules/*` are thin adapters over this package; unit
 * tests import it directly. Nothing here imports `electron`, so the whole chain
 * (version merge, Java detection, argument building, process supervision) can be
 * tested in plain Node.
 */
export { CoreError, CORE_ERRORS, isCoreError, asCoreError } from './errors'
export type { CoreErrorCode, ErrorCategory } from './errors'

export * from './version/types'
export { flattenVersionChain } from './version/inherit'
export { isRuleSetAllowed, evaluateArguments, splitLegacyArguments, createRuleContext } from './version/rules'
export {
  detectLoader,
  detectMinecraftVersion,
  findVersionDir,
  loadVersionChain,
  parseVersionJson,
  resolveClientJar,
  resolveVersion,
  versionsDirectory,
} from './version/load'
export { scanVersionDirs } from './version/scan'
export { inspectVersion, flattenVersionFile } from './version/inspect'
export { resolveLibraries, joinClasspath } from './version/classpath'

export { parseJavaVersion, javaMajorForMinecraft, encodingForCodePage } from './java/version'
export { probeJavaExecutable, parseJavaProbeOutput } from './java/probe'
export { detectJava, JavaDetectionCache, resolveJavaExecutable } from './java/detect'
export { chooseJava, requiredJavaMajor } from './java/select'

export {
  defaultInstanceSettings,
  gameDirectory,
  instanceDirectory,
  nativesDirectory,
  readInstanceSettings,
  writeInstanceSettings,
} from './instance/settings'
export { findInstance, scanInstances } from './instance/scan'

export {
  buildLaunchPlan,
  assertNoManagedJvmArgs,
  substitutePlaceholders,
} from './launch/args'
export type {
  AuthlibInjection,
  BuildLaunchPlanInput,
  LaunchAccount,
  LaunchPaths,
  LaunchPlanCore,
  LaunchSettings,
} from './launch/args'
export { planNatives, extractNatives } from './launch/natives'
export { detectCrashHints, primaryConclusion, CRASH_RULES } from './launch/hints'
export { LineSplitter, startLaunchProcess } from './launch/process'
export type { LaunchExit, LaunchLine, LaunchProcessHandle } from './launch/process'
export {
  allocateGameLogFile,
  formatLocalStamp,
  gameLogDirectory,
  updateLaunchLastExit,
  writeLaunchArtifacts,
} from './launch/artifacts'
export {
  autoMaxMemoryMb,
  detectWindowsCodePage,
  logEncodingForCodePage,
} from './launch/settings'
export { LaunchOrchestrator } from './launch/orchestrator'
export type {
  LaunchOrchestratorOptions,
  LaunchRequestInput,
  PreparedLaunch,
} from './launch/orchestrator'

export { ZipArchive, extractZip, openZipFile, crc32 } from './zip/reader'
export { nodeFsPort, nodeProcessPort } from './ports'
export type { FsPort, ProcessPort, ExecResult } from './ports'
