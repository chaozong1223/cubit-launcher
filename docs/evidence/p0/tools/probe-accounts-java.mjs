// t34 P0-2/P0-3/P0-7 probe: offline UUIDs, invalid names, persistence, account
// switching, forced Java 21, Microsoft missing-config and Authlib injection.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 'qa-02-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const result = { workspace: ws, dataDir }
let app = await launch({ name: 'P0-2', dataDir, mcDir, port: 9396 })
try {
  const testUser = await app.invoke('mc:auth:createOffline', { name: 'TestUser' })
  const second = await app.invoke('mc:auth:createOffline', { name: 'SecondUser' })
  result.accounts = {
    testUser: { id: testUser.id, name: testUser.name, uuid: testUser.uuid, kind: testUser.kind },
    second: { id: second.id, name: second.name, uuid: second.uuid, kind: second.kind },
  }
  result.invalid = {}
  for (const name of ['ab', 'a b', 'abcdefghijklmnopq', '张三']) {
    result.invalid[name] = await app.invokeRaw('mc:auth:createOffline', { name })
  }
  const afterInvalid = await app.invoke('mc:auth:list')
  result.invalidAccountCount = afterInvalid.accounts.length

  // Plan for both users (switch must not leak the previous name).
  const planTest = await app.invoke('mc:launch:plan', { instanceId: '1.20.1', accountId: testUser.id, dryRun: true })
  const planSecond = await app.invoke('mc:launch:plan', { instanceId: '1.20.1', accountId: second.id, dryRun: true })
  const pick = (argv, flag) => argv[argv.indexOf(flag) + 1]
  result.plans = {
    testUser: { username: pick(planTest.argv, '--username'), uuid: pick(planTest.argv, '--uuid'), accessToken: pick(planTest.argv, '--accessToken'), userType: pick(planTest.argv, '--userType') },
    second: { username: pick(planSecond.argv, '--username'), uuid: pick(planSecond.argv, '--uuid'), accessToken: pick(planSecond.argv, '--accessToken'), userType: pick(planSecond.argv, '--userType') },
    leak: planSecond.argv.includes('TestUser'),
  }

  // Forced Java 21 must change the plan from the 1.20.1 default 17.
  await app.invoke('mc:instance:update', { id: '1.20.1', patch: { java: { mode: 'major', value: 21 } } })
  const planJava21 = await app.invoke('mc:launch:plan', { instanceId: '1.20.1', accountId: testUser.id, dryRun: true })
  result.java21 = { javaPath: planJava21.javaPath, javaMajor: planJava21.javaMajor }
  await app.invoke('mc:instance:update', { id: '1.20.1', patch: { java: { mode: 'auto', value: null } } })

  // Microsoft path without a client id.
  result.microsoft = await app.invokeRaw('mc:auth:beginDeviceCode')
  // Authlib account + injection in a real plan.
  const authlib = await app.invoke('mc:auth:createAuthlib', { name: 'AuthUser', server: 'https://littleskin.cn/api/yggdrasil' })
  result.authlib = { id: authlib.id, kind: authlib.kind, server: authlib.server }
  result.authlibInfo = await app.invoke('mc:auth:ensureAuthlib')
  const planAuthlib = await app.invoke('mc:launch:plan', { instanceId: '1.20.1', accountId: authlib.id, dryRun: true })
  result.authlibAgent = planAuthlib.argv.find((a) => a.startsWith('-javaagent:')) ?? null
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
}

// Restart and check the selected account survives.
app = await launch({ name: 'P0-2', dataDir, mcDir, port: 9397 })
try {
  const list = await app.invoke('mc:auth:list')
  result.persisted = { selectedId: list.selectedId, accounts: list.accounts.map((a) => ({ name: a.name, kind: a.kind })) }
  const accountsFile = path.join(dataDir, 'accounts.json')
  result.accountsFile = { exists: fs.existsSync(accountsFile), content: fs.existsSync(accountsFile) ? fs.readFileSync(accountsFile, 'utf8') : null }
  const files = fs.readdirSync(dataDir, { recursive: true }).filter((f) => fs.statSync(path.join(dataDir, f)).isFile())
  const hits = []
  for (const rel of files) {
    if (!/\.(json|log|jsonl|txt|bat)$/i.test(String(rel))) continue
    const text = fs.readFileSync(path.join(dataDir, rel), 'utf8')
    if (text.includes('eyJ')) hits.push({ file: rel, pattern: 'eyJ' })
    if (/"accessToken"\s*:\s*"[^0]/.test(text)) hits.push({ file: rel, pattern: 'accessToken-field' })
  }
  result.secretScan = { files: files.length, hits }
} catch (error) {
  result.persistedFatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-2', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    accounts: result.accounts,
    invalid: Object.fromEntries(Object.entries(result.invalid ?? {}).map(([k, v]) => [k, { ok: v.ok, code: v.error?.code, message: v.error?.message }])),
    invalidAccountCount: result.invalidAccountCount,
    plans: result.plans,
    java21: result.java21,
    microsoft: { ok: result.microsoft?.ok, code: result.microsoft?.error?.code, message: result.microsoft?.error?.message },
    authlibAgent: result.authlibAgent,
    authlibInfo: result.authlibInfo && { version: result.authlibInfo.version, sha256: result.authlibInfo.sha256, downloaded: result.authlibInfo.downloaded },
    persisted: result.persisted,
    secretHits: result.secretScan?.hits,
    fatal: result.fatal ?? result.persistedFatal ?? null,
  }, null, 2))
}
