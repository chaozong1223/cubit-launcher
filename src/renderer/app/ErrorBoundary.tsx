import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from './icons'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The main-process smoke report only counts uncaught errors; keeping this
    // in console preserves the detail without inventing a recovery claim.
    console.error('renderer error boundary:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app">
          <main className="content">
            <div className="page">
              <div className="card nw-panel nw-panel--error" role="alert">
                <span className="nw-panel__icon"><Icon name="alert-circle" /></span>
                <div className="nw-panel__body">
                  <div className="nw-panel__title">界面渲染失败</div>
                  <p className="nw-panel__detail">{this.state.error.message}</p>
                  <p className="nw-panel__foot">请查看启动器日志；此页面不会伪造恢复状态。</p>
                  <button className="btn btn--secondary btn--sm" type="button" onClick={() => location.reload()}>
                    重新加载界面
                  </button>
                </div>
              </div>
            </div>
          </main>
        </div>
      )
    }
    return this.props.children
  }
}
