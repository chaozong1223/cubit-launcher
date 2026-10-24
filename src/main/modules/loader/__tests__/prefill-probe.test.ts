import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { nodeFsPort } from '../../../core/ports'
import { installerProfileTasks } from '../core/profile'

const JARS = [
  'D:/DSH-工作文件/mc-launcher/release/win-unpacked/data/modules/loader/cache/installers/forge-1.12.2-14.23.5.2864-installer.jar',
  'D:/DSH-工作文件/mc-launcher/release/win-unpacked/data/modules/loader/cache/installers/forge-1.20.1-47.4.28-installer.jar',
]

describe('installer prefill probe', () => {
  it('parses the real installer jars', () => {
    for (const jar of JARS) {
      if (!fs.existsSync(jar)) {
        console.log('SKIP missing', jar)
        continue
      }
      const result = installerProfileTasks(nodeFsPort(), jar)
      const sample = result.tasks.slice(0, 2).map((task) => ({
        dest: task.destRel,
        url: task.url.slice(0, 90),
        mirror: task.mirrorUrl ? task.mirrorUrl.slice(0, 90) : null,
      }))
      console.log(
        JSON.stringify(
          {
            jar: jar.split('/').pop(),
            found: result.found,
            tasks: result.tasks.length,
            mirrored: result.tasks.filter((task) => task.mirrorUrl).length,
            warnings: result.warnings.slice(0, 2),
            sample,
          },
          null,
          1,
        ),
      )
      expect(result.found).toBe(true)
    }
  })
})
