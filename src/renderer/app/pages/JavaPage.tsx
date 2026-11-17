import { Card } from '../ui'
import { JavaListPanel } from './JavaListPanel'
import { JavaDownloadPanel } from './JavaDownloadPanel'

/**
 * The Java page: every runtime the launcher can see, plus a one-click install
 * card. The per-instance override still lives in Settings > Java next to the
 * instance picker, so this page stays read-mostly.
 */
export function JavaPage() {
  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Java</h1>
          <p className="page__sub">启动器能看到的全部运行时；默认值可全局设置，实例级选择仍然优先。</p>
        </div>
      </header>
      <Card className="settings-content">
        <div className="settings-section">
          <div className="settings-section__body">
            <JavaListPanel />
          </div>
        </div>
      </Card>
      <Card className="settings-content">
        <div className="settings-section">
          <div className="settings-section__body">
            <JavaDownloadPanel />
          </div>
        </div>
      </Card>
    </div>
  )
}
