// Hidden easter-egg menu: typing "michael" anywhere while in a game (chat input included —
// the trigger listens at the window level and never preventDefaults) toggles a small panel
// of prank effects. Effects broadcast to every human client in the room through the
// rooms/{roomId}/effects subcollection (see firebase/rooms.ts) — bots have no screens, so
// "everyone but bots" falls out for free. The sender's own screen is skipped unless the
// "Affect self" toggle is on.
import { useEffect, useRef, useState, type JSX } from 'react';
import { sendEffect, subscribeEffects, type SecretEffect } from '../firebase/rooms';
import shipIcon from '../assets/decor/ship.png';
import './SecretMenu.css';

const TRIGGER = 'michael';
// Ignore effect docs older than this on arrival — a client that reconnects mid-game should
// not replay every flashbang fired while it was away (the first-snapshot guard below covers
// the common case; this covers docs that land late through a flaky connection).
const EFFECT_FRESH_MS = 15000;
const FLASHBANG_MS = 3000;
const SHIP_MS = 7000;

interface ActiveEffect {
  key: string;
  kind: SecretEffect['kind'];
  /** % from the top of the viewport the ship sails across at. */
  top: number;
}

export interface SecretMenuProps {
  roomId: string;
  uid: string;
}

export default function SecretMenu({ roomId, uid }: SecretMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [affectSelf, setAffectSelf] = useState(false);
  const [active, setActive] = useState<ActiveEffect[]>([]);
  const bufferRef = useRef('');

  // Trigger listener. Deliberately does NOT filter out INPUT/TEXTAREA targets (unlike
  // Game.tsx's shortcut listener) — the whole point is that typing the word anywhere,
  // including mid-sentence in the chat box, opens the menu. Observe-only: no preventDefault,
  // so the letters still land wherever they were headed.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      bufferRef.current = (bufferRef.current + e.key.toLowerCase()).slice(-TRIGGER.length);
      if (bufferRef.current === TRIGGER) {
        bufferRef.current = '';
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const seenIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    // The dev preview harnesses (?preview=trade etc.) seed a fake room with no emulator
    // wiring — don't open a live Firestore listener from them. The menu itself (and its
    // local rendering) still works there for screenshots.
    if (new URLSearchParams(window.location.search).has('preview')) return;
    seenIdsRef.current = null;
    return subscribeEffects(roomId, (effects) => {
      const seen = seenIdsRef.current;
      if (seen === null) {
        // First snapshot is history from before this client subscribed — mark it all seen,
        // play nothing (same pattern as Game.tsx's trade-sound seenTradeIdsRef).
        seenIdsRef.current = new Set(effects.map((e) => e.id));
        return;
      }
      for (const effect of effects) {
        if (seen.has(effect.id)) continue;
        seen.add(effect.id);
        if (Date.now() - effect.ts > EFFECT_FRESH_MS) continue;
        if (effect.uid === uid && !effect.affectSelf) continue;
        const key = effect.id;
        setActive((cur) => [...cur, { key, kind: effect.kind, top: 12 + Math.random() * 55 }]);
        setTimeout(() => {
          setActive((cur) => cur.filter((a) => a.key !== key));
        }, effect.kind === 'flashbang' ? FLASHBANG_MS : SHIP_MS);
      }
    });
  }, [roomId, uid]);

  return (
    <>
      {open && (
        <div className="secret-menu" role="dialog" aria-label="Secret menu">
          <div className="secret-menu__title">🤫 Secret menu</div>
          <button
            type="button"
            className="secret-menu__button"
            onClick={() => void sendEffect(roomId, uid, 'flashbang', affectSelf).catch(() => {})}
          >
            💥 Flashbang
          </button>
          <button
            type="button"
            className="secret-menu__button"
            onClick={() => void sendEffect(roomId, uid, 'ship', affectSelf).catch(() => {})}
          >
            ⛵ Ship
          </button>
          <label className="secret-menu__toggle">
            <input type="checkbox" checked={affectSelf} onChange={(e) => setAffectSelf(e.target.checked)} />
            Affect self
          </label>
          <button type="button" className="secret-menu__close" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
      {active.map((a) =>
        a.kind === 'flashbang' ? (
          <div key={a.key} className="secret-fx-flashbang" aria-hidden="true" />
        ) : (
          <img
            key={a.key}
            src={shipIcon}
            className="secret-fx-ship"
            style={{ top: `${a.top}%` }}
            alt=""
            aria-hidden="true"
          />
        ),
      )}
    </>
  );
}
