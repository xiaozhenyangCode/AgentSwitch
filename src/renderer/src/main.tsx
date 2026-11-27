import './lib/legacyStorage' // first: copies AgentMux-era localStorage keys before stores load
import './state/theme' // before first paint: applies .dark from the saved appearance
import './state/i18n' // before first paint: UI language from settings.json
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installAutoHideScrollbars } from './lib/scrollbar'
import './index.css'

installAutoHideScrollbars()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
