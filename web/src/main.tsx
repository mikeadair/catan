import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const previewMode = new URLSearchParams(window.location.search).get('preview')
const Root =
  previewMode === 'board'
    ? (await import('./DevPreview.tsx')).default
    : previewMode === 'trade'
      ? (await import('./TradePreview.tsx')).default
      : previewMode === 'home'
        ? (await import('./HomePreview.tsx')).default
        : previewMode === 'lobby'
          ? (await import('./LobbyPreview.tsx')).default
          : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
