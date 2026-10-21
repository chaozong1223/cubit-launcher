import path from 'node:path'
import type { LoaderDryRunResult, LoaderVerifyResult } from '@shared/loader'
import type { FsPort } from '../../../core/ports'
import { CoreError } from '../../../core/errors'
import { inspectVersion } from '../../../core/version/inspect'
import { resolveVersion } from '../../../core/version/load'
import {
  buildLaunchPlan,
  type LaunchAccount,
  type LaunchPaths,
  type LaunchSettings,
} from '../../../core/launch/args'
import { LoaderError } from './errors'

/**
 * Post-install verification against the t6 launch kernel.
 *
 * `verify` proves the produced version can be merged/listed; `dryRun` builds a
 * full command line without creating a process (01 R1.15) so the loader task's
 * acceptance criterion can be checked end-to-end.
 */

const SYNTHETIC_ACCOUNT: LaunchAccount = {
  kind: 'offline',
  name: 'TestUser',
  uuid: '097d3392-865a-3f3c-8b4a-da1c3473466c',
  accessToken: '0',
  userType: 'legacy',
}

export function verifyInstalledVersion(
  fs: FsPort,
  mcRoot: string,
  versionId: string,
): LoaderVerifyResult {
  try {
    const resolved = resolveVersion(fs, mcRoot, versionId)
    const inspection = inspectVersion(fs, mcRoot, versionId)
    return {
      versionId: resolved.id,
      chain: resolved.chainIds,
      mainClass: typeof resolved.json.mainClass === 'string' ? resolved.json.mainClass : null,
      loader: { type: resolved.loader.type, version: resolved.loader.version },
      libraries: inspection.libraries.total,
      classpathCount: inspection.classpath.length,
      javaMajor: resolved.javaMajor,
      warnings: [...resolved.warnings, ...inspection.warnings],
    }
  } catch (error) {
    throw new LoaderError('LOADER.VERIFY_FAILED', {
      message:
        error instanceof CoreError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error),
      details: error instanceof CoreError ? error.toShape() : undefined,
      cause: error,
    })
  }
}

export interface DryRunOptions {
  javaPath?: string
  javaMajor?: number | null
  launcherVersion?: string
  platform?: NodeJS.Platform
  arch?: string
  account?: LaunchAccount
}

export function dryRunInstalledVersion(
  fs: FsPort,
  mcRoot: string,
  versionId: string,
  options: DryRunOptions = {},
): LoaderDryRunResult {
  try {
    const resolved = resolveVersion(fs, mcRoot, versionId)
    const inspection = inspectVersion(fs, mcRoot, versionId)
    const versionDir = path.join(mcRoot, 'versions', resolved.dirName)
    const paths: LaunchPaths = {
      mcRoot,
      versionDir,
      gameDir: versionDir,
      assetsDir: path.join(mcRoot, 'assets'),
      librariesDir: path.join(mcRoot, 'libraries'),
      nativesDir: inspection.directories.nativesDir,
      clientJar: resolved.clientJar,
    }
    const javaMajor = options.javaMajor ?? resolved.javaMajor ?? 17
    const settings: LaunchSettings = {
      javaPath: options.javaPath ?? 'java',
      javaMajor,
      minMemoryMb: 1024,
      maxMemoryMb: 4096,
      width: 1280,
      height: 720,
      fullscreen: false,
      extraJvmArgs: [],
      server: null,
      authlib: null,
      codePage: 65001,
      launcherName: 'mc-launcher',
      launcherVersion: options.launcherVersion ?? '0.1.0',
    }
    const plan = buildLaunchPlan({
      version: resolved.json,
      versionName: resolved.dirName,
      mcVersion: resolved.mcVersion,
      account: options.account ?? SYNTHETIC_ACCOUNT,
      paths,
      settings,
      dryRun: true,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.arch ? { arch: options.arch } : {}),
      exists: (target) => fs.exists(target),
    })
    return {
      versionId: resolved.id,
      mainClass: typeof resolved.json.mainClass === 'string' ? resolved.json.mainClass : null,
      argv: plan.argv,
      classpathCount: plan.classpath.length,
      syntheticAccount: !options.account,
      hasPlaceholders: plan.argv.some((argument) => argument.includes('${')),
      warnings: plan.warnings,
    }
  } catch (error) {
    if (error instanceof LoaderError) throw error
    throw new LoaderError('LOADER.DRY_RUN_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof CoreError ? error.toShape() : undefined,
      cause: error,
    })
  }
}
