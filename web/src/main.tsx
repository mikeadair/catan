import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const isPreview = new URLSearchParams(window.location.search).get('preview') === 'board'
const Root = isPreview ? (await import('./DevPreview.tsx')).default : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
