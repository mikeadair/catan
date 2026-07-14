// Temporary, local-only preview harness (same spirit as TradePreview.tsx/DevPreview.tsx) for
// snapping the main-menu screen without a live Firebase room or auth flow. Home only needs a
// `uid` prop — it doesn't read the zustand store at all — so there's nothing to seed here.
// Home does call useAuthUser() internally, which attaches a real onIdTokenChanged listener
// against the real `mikeadair-catan` project (this harness intentionally has no emulator
// wiring, same as TradePreview/DevPreview); with no persisted/signed-in session in a fresh
// Playwright context that's a passive listener, not a write, so it's harmless for a screenshot.
// Wired in from main.tsx behind ?preview=home.
import type { JSX } from 'react';
import Home from './routes/Home';

export default function HomePreview(): JSX.Element {
  return <Home uid="preview-uid" />;
}
