// Hidden easter-egg menu: typing "michael" anywhere while in a game (chat input included —
// the trigger listens at the window level and never preventDefaults) toggles a small panel
// of prank effects. Effects broadcast to every human client in the room through the
// rooms/{roomId}/effects subcollection (see firebase/rooms.ts) — bots have no screens, so
// "everyone but bots" falls out for free. The sender's own screen is skipped unless the
// "Affect self" toggle is on.
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { IconType } from 'react-icons';
import { GiEarthCrack, GiFlashGrenade, GiPartyPopper, GiSailboat, GiSheep } from 'react-icons/gi';
import { PiDiscoBallFill } from 'react-icons/pi';
import { sendEffect, subscribeEffects, type SecretEffect } from '../firebase/rooms';
import shipIcon from '../assets/decor/ship.png';
import ConfettiBurst from './ConfettiBurst';
import './SecretMenu.css';

const TRIGGER = 'michael';
// Ignore effect docs older than this on arrival — a client that reconnects mid-game should
// not replay every flashbang fired while it was away (the first-snapshot guard below covers
// the common case; this covers docs that land late through a flaky connection).
const EFFECT_FRESH_MS = 15000;

// How long each effect stays mounted (or, for the body-class effects, applied) — sized to
// each one's CSS animation plus its longest per-piece delay, not a shared constant.
const EFFECT_MS: Record<SecretEffect['kind'], number> = {
  flashbang: 3000,
  ship: 7000,
  confetti: 3500,
  quake: 2500,
  sheep: 5600,
  disco: 4000,
};

// SVG icons (react-icons) rather than emoji — 🪩 is Unicode 14 and simply missing from the
// emoji font on plenty of not-that-old systems, and SVGs render identically everywhere.
// Mostly the game-icons.net set (Gi*, thematically at home in Catan); the disco ball is the
// one icon it lacks, borrowed from Phosphor (Pi*).
const EFFECT_BUTTONS: { kind: SecretEffect['kind']; label: string; Icon: IconType }[] = [
  { kind: 'flashbang', label: 'Flashbang', Icon: GiFlashGrenade },
  { kind: 'ship', label: 'Ship', Icon: GiSailboat },
  { kind: 'confetti', label: 'Confetti', Icon: GiPartyPopper },
  { kind: 'quake', label: 'Earthquake', Icon: GiEarthCrack },
  { kind: 'sheep', label: 'Sheep rain', Icon: GiSheep },
  { kind: 'disco', label: 'Disco', Icon: PiDiscoBallFill },
];

// Deterministic (index-based) sheep placement, same reasoning as ConfettiBurst: stable
// across re-renders and in snap screenshots. Each sheep gets its own size, fall speed,
// sway rhythm/amplitude, and half of them face the other way — a flock, not a grid.
const SHEEP_COUNT = 20;
const SHEEP = Array.from({ length: SHEEP_COUNT }, (_, i) => ({
  key: i,
  left: (i * 47) % 100,
  delay: ((i * 89) % 1600) / 1000,
  duration: 2.8 + ((i * 37) % 1400) / 1000,
  size: 24 + ((i * 13) % 20),
  swayDuration: 1.1 + ((i * 29) % 900) / 1000,
  swayAmp: 10 + ((i * 17) % 26),
  flip: i % 2 === 1,
}));

interface ActiveEffect {
  key: string;
  kind: SecretEffect['kind'];
  /** % from the top of the viewport the ship sails across at. */
  top: number;
}

export interface SecretMenuProps {
  roomId: string;
  uid: string;
  /** Which screen edge to float against — Game.tsx passes the side the sidebar ISN'T on, so
   * the open menu hangs over open board water instead of covering the roster/log. */
  side: 'left' | 'right';
}

export default function SecretMenu({ roomId, uid, side }: SecretMenuProps): JSX.Element | null {
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

  // Dev preview only: `?preview=trade&fx=<kind>` pre-plays one effect on mount (no expiry
  // timer), so the snap harness can screenshot effect visuals without a live Firestore room —
  // see the fx-sheep entry in e2e/snap-components.ts.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('preview')) return;
    const kind = params.get('fx') as SecretEffect['kind'] | null;
    if (kind) setActive([{ key: 'preview-fx', kind, top: 30 }]);
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
        }, EFFECT_MS[effect.kind] ?? 3000);
      }
    });
  }, [roomId, uid]);

  // Quake and disco act on the whole page (a transform/filter animation on <body> — that's
  // what makes the *entire* viewport, fixed overlays included, shake or hue-spin), so they're
  // body classes rather than rendered layers. Toggled off both when the effect expires and on
  // unmount, so leaving the game can't strand a class on <body>.
  const quakeActive = active.some((a) => a.kind === 'quake');
  const discoActive = active.some((a) => a.kind === 'disco');
  useEffect(() => {
    document.body.classList.toggle('secret-fx-quake', quakeActive);
    return () => document.body.classList.remove('secret-fx-quake');
  }, [quakeActive]);
  useEffect(() => {
    document.body.classList.toggle('secret-fx-disco', discoActive);
    return () => document.body.classList.remove('secret-fx-disco');
  }, [discoActive]);

  return (
    <>
      {open && (
        <div className={`secret-menu secret-menu--${side}`} role="dialog" aria-label="Secret menu">
          <div className="secret-menu__title">🤫 Secret menu</div>
          <div className="secret-menu__hint">Broadcasts to everyone in the room.</div>
          {EFFECT_BUTTONS.map(({ kind, label, Icon }) => (
            <button
              key={kind}
              type="button"
              className="secret-menu__button"
              onClick={() => void sendEffect(roomId, uid, kind, affectSelf).catch(() => {})}
            >
              <Icon className="secret-menu__button-icon" aria-hidden="true" />
              {label}
            </button>
          ))}
          <label className="secret-menu__toggle">
            <input type="checkbox" checked={affectSelf} onChange={(e) => setAffectSelf(e.target.checked)} />
            Affect self
          </label>
          <button type="button" className="secret-menu__close" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
      {active.map((a) => {
        if (a.kind === 'flashbang') {
          return <div key={a.key} className="secret-fx-flashbang" aria-hidden="true" />;
        }
        if (a.kind === 'ship') {
          return (
            <img
              key={a.key}
              src={shipIcon}
              className="secret-fx-ship"
              style={{ top: `${a.top}%` }}
              alt=""
              aria-hidden="true"
            />
          );
        }
        if (a.kind === 'confetti') {
          return (
            <div key={a.key} className="secret-fx-confetti" aria-hidden="true">
              <ConfettiBurst />
            </div>
          );
        }
        if (a.kind === 'sheep') {
          // Three nested layers so the transforms don't fight: outer falls, middle sways/
          // wobbles side to side on its own rhythm, inner just holds the size + mirror flip.
          return (
            <div key={a.key} className="secret-fx-sheep" aria-hidden="true">
              {SHEEP.map((s) => (
                <span
                  key={s.key}
                  className="secret-fx-sheep__drop"
                  style={{
                    left: `${s.left}%`,
                    animationDelay: `${s.delay}s`,
                    animationDuration: `${s.duration}s`,
                  }}
                >
                  <span
                    className="secret-fx-sheep__sway"
                    style={{ animationDuration: `${s.swayDuration}s`, '--sheep-sway': `${s.swayAmp}px` } as CSSProperties}
                  >
                    <GiSheep
                      className="secret-fx-sheep__icon"
                      style={{ fontSize: s.size, transform: s.flip ? 'scaleX(-1)' : undefined }}
                    />
                  </span>
                </span>
              ))}
            </div>
          );
        }
        return null; // quake/disco render via body classes above
      })}
    </>
  );
}
