import { createRoot } from 'react-dom/client'
import App from './App'
import { BackendProvider } from './data/BackendContext'
import { ThemeProvider } from './theme'
import { ErrorBoundary } from './ErrorBoundary'
import './design.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('root element missing')

createRoot(container).render(
  <BackendProvider>
    <ThemeProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ThemeProvider>
  </BackendProvider>,
)
