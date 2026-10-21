// t61: B2 settings UI, B3 domain error codes, B6 account entries, B4 crash report.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 't61-ui-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const outDir = path.join(ROOT, 'docs', 'evidence', 't61')
const result = { workspace: ws, dataDir }
const app = await launch({ name: 't61', dataDir, mcDir, port: 9521 })

const clickExact = async (text) => app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (!b) return 'missing'; b.click(); return 'clicked' })()`)
const setInput = async (label, value) => app.evaluate(`(() => {
  const el = document.querySelector('input[aria-label=${JSON.stringify(label)}]')
  if (!el) return 'missing'
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return el.value
})()`)
const setTextarea = async (label, value) => app.evaluate(`(() => {
  const el = document.querySelector('textarea[aria-label=${JSON.stringify(label)}]')
  if (!el) return 'missing'
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el.value
})()`)

try {
  const account = await app.invoke('mc:auth:createOffline', { name: 'T61Ui' })
  await app.invoke('mc:auth:select', { id: account.id })

  // B2: settings UI writes instance fields and dry-run reflects them.
  await app.goto('#/settings/launch', 1800)
  await sleep(1200)
  result.settingsBefore = (await app.text()).split('\n').map((s) => s.trim()).filter((l) => /内存|窗口|JVM|保存实例设置|dry-run|1\.20\.1/.test(l)).slice(0, 20)
  result.setMin = await setInput('最小内存 MB', '1024')
  result.setMax = await setInput('最大内存 MB', '4096')
  result.setWidth = await setInput('窗口宽度', '1280')
  result.setHeight = await setInput('窗口高度', '720')
  result.setJvm = await setTextarea('自定义 JVM 参数', '-Dmcl.t61=1')
  result.saveSettings = await clickExact('保存实例设置')
  await sleep(3000)
  result.settingsAfter = (await app.text()).split('\n').map((s) => s.trim()).filter((l) => /已保存|Xmx|Xms|1280|720|mcl\.t61|保存实例设置/.test(l)).slice(0, 16)
  result.planAfterSave = await app.invoke('mc:launch:plan', { instanceId: '1.20.1', accountId: account.id, dryRun: true })
  result.planCheck = {
    xmx: result.planAfterSave.argv.filter((a) => a.startsWith('-Xmx')),
    width: result.planAfterSave.argv[result.planAfterSave.argv.indexOf('--width') + 1],
    height: result.planAfterSave.argv[result.planAfterSave.argv.indexOf('--height') + 1],
    custom: result.planAfterSave.argv.filter((a) => a.startsWith('-Dmcl.t61=')),
  }
  result.instanceJson = fs.existsSync(path.join(mcDir, 'versions', '1.20.1', 'instance.json'))
    ? JSON.parse(fs.readFileSync(path.join(mcDir, 'versions', '1.20.1', 'instance.json'), 'utf8'))
    : null
  result.settingsScreenshot = await app.screenshot('settings-launch.png')

  // B3: domain codes must survive IPC.
  await app.invoke('mc:instance:update', { id: '1.20.1', patch: { java: { mode: 'path', value: 'C:\\no-such-dir\\java.exe' } } })
  result.codeJava = await app.invokeRaw('mc:launch:plan', { instanceId: '1.20.1', accountId: account.id, dryRun: true })
  await app.invoke('mc:instance:update', { id: '1.20.1', patch: { java: { mode: 'auto', value: null } } })
  result.codeLoader = await app.invokeRaw('mc:loader:install', { type: 'fabric', mcVersion: '1.20.4' })
  result.codeInvite = await app.invokeRaw('mc:net:copyInvite')
  result.codeRepair = await app.invokeRaw('mc:repair:scan', { versionId: 'no-such-version', verify: 'hash' })
  result.codeMissingJar = await app.invokeRaw('mc:launch:start', { instanceId: 'no-such-instance', accountId: account.id })
  result.codeList = {
    java: result.codeJava?.error?.code,
    loader: result.codeLoader?.error?.code,
    invite: result.codeInvite?.error?.code,
    repair: result.codeRepair?.error?.code,
    missingJar: result.codeMissingJar?.error?.code,
  }

  // B6: account page entries + Microsoft missing-config honest error.
  await app.goto('#/settings/account', 1600)
  result.accountText = (await app.text()).split('\n').map((s) => s.trim()).filter((l) => /微软|Authlib|离线|设备码|未配置|登录/.test(l)).slice(0, 20)
  result.accountScreenshot = await app.screenshot('account-entries.png')
  result.microsoftClick = await clickExact('开始微软登录')
  await sleep(2500)
  result.microsoftText = (await app.text()).split('\n').map((s) => s.trim()).filter((l) => /MS_CLIENT_ID_MISSING|未配置微软|client id|失败/.test(l)).slice(0, 8)
  result.microsoftScreenshot = await app.screenshot('account-microsoft-error.png')

  // B4: crash report file on a real bad JVM arg.
  await app.invoke('mc:instance:update', { id: '1.20.1', patch: { jvmArgs: ['-XX:+UseDefinitelyNotARealGC'], window: { width: 1280, height: 720, fullscreen: false } } })
  const crash = await app.invoke('mc:launch:start', { instanceId: '1.20.1', accountId: account.id })
  let crashStatus = null
  for (let i = 0; i < 120; i += 1) {
    crashStatus = await app.invoke('mc:launch:status', { instanceId: '1.20.1' })
    if (crashStatus.state === 'crashed' || crashStatus.state === 'exited') break
    await sleep(250)
  }
  await sleep(2500)
  result.crashStatus = crashStatus
  result.crashReport = await app.invoke('mc:launch:lastReport', { instanceId: '1.20.1' })
  const dataReports = fs.existsSync(path.join(dataDir, 'crash-reports')) ? fs.readdirSync(path.join(dataDir, 'crash-reports')) : []
  const instanceReports = fs.existsSync(path.join(mcDir, 'versions', '1.20.1', 'crash-reports')) ? fs.readdirSync(path.join(mcDir, 'versions', '1.20.1', 'crash-reports')) : []
  result.crashFiles = { dataReports, instanceReports }
  const firstReport = dataReports[0] ? path.join(dataDir, 'crash-reports', dataReports[0]) : null
  result.crashReportText = firstReport ? fs.readFileSync(firstReport, 'utf8').split(/\r?\n/).slice(0, 18) : null
  await app.goto('#/home', 1500)
  await sleep(2500)
  result.crashPanelScreenshot = await app.screenshot('crash-panel-auto.png')
  result.crashPanelText = (await app.text()).split('\n').map((s) => s.trim()).filter((l) => /JVM|崩溃|Unrecognized|置信|诊断|分析/.test(l)).slice(0, 16)
  await app.invoke('mc:instance:update', { id: '1.20.1', patch: { jvmArgs: [] } })

  // B4: log rotation implementation evidence via unit test run.
  result.logFiles = fs.existsSync(path.join(dataDir, 'logs')) ? fs.readdirSync(path.join(dataDir, 'logs')) : []
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  try { await app.screenshot('fatal.png') } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('t61', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    settings: { before: result.settingsBefore?.slice(0, 6), after: result.settingsAfter, plan: result.planCheck, instanceMemory: result.instanceJson?.memory, memoryMode: result.instanceJson?.memoryMode, window: result.instanceJson?.window, jvmArgs: result.instanceJson?.jvmArgs },
    codes: result.codeList,
    codesRaw: Object.fromEntries(Object.entries({ java: result.codeJava, loader: result.codeLoader, invite: result.codeInvite, repair: result.codeRepair, missingJar: result.codeMissingJar }).map(([k, v]) => [k, { code: v?.error?.code, message: v?.error?.message, technical: v?.error?.technicalMessage, cause: v?.error?.causeCode }])),
    account: result.accountText?.slice(0, 8),
    microsoft: result.microsoftText,
    crash: { state: result.crashStatus?.state, reportClass: result.crashReport?.classification, hints: result.crashReport?.crashHints?.map((h) => h.category), files: result.crashFiles, text: result.crashReportText?.slice(0, 8), panel: result.crashPanelText?.slice(0, 8) },
    logFiles: result.logFiles,
    fatal: result.fatal ?? null,
  }, null, 2))
}
