import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Board, EdgeId, PublicPlayer, RoomState, Terrain, VertexId } from '@catan/engine';
import { TERRAIN_RESOURCE } from '@catan/engine';
import { edgeMidpoint, hexPixel, pipCount, vertexLegalForFogSetup, vertexPixel } from '@catan/engine';
import { PLAYER_COLOR_HEX } from './playerColors';
import { RESOURCE_ICON } from './resourceIcons';
import desertIcon from '../assets/terrain/desert.png';
import robberIcon from '../assets/terrain/robber.png';
import './Board.css';

const SIZE = 56;

// Pointer movement (in screen px) past which a pointer-down is treated as a drag/pan rather
// than a tap — keeps small hand-tremor/touch jitter from hijacking clicks on hexes/edges/
// vertices while still letting an intentional drag start panning immediately.
const DRAG_THRESHOLD_PX = 6;

// Shifts the number-token circle (+ digit + pips) up from dead-center so it doesn't visually
// overlap the terrain icon anchored below it (iconCenterY = center.y + SIZE * 0.5, see below)
// — the icon's own top edge sits just a hair below hex-center, so with no offset the token's
// bottom edge cuts straight across the icon's top instead of leaving a clean gap. Doesn't
// touch the icon's own position, only the token's.
const NUMBER_TOKEN_Y_OFFSET = -14;

const DESERT_COLOR = '#c9b57a';
const GOLD_COLOR = '#d9b64e';
// fog-of-war: undiscovered hexes render as this generic "unknown" fill/icon rather than
// their real terrain — a deliberate client-rendering choice, not a security boundary (the
// real terrain is still present in room.board, same trust model as everything else in this
// client-authoritative-reads architecture); only the number token is genuinely undetermined
// server-side until discovery.
const FOG_COLOR = '#333c46';

export type BoardInteractionMode = 'none' | 'placeSettlement' | 'placeCity' | 'placeRoad' | 'placeRobber';

export interface BoardProps {
  room: RoomState;
  players: Record<string, PublicPlayer>;
  uid: string | null;
  interactionMode: BoardInteractionMode;
  /** Relaxes settlement/road legality filtering to the setup-phase rules. */
  freeSetup?: boolean;
  /** Edges chosen-but-not-yet-dispatched (Road Building card), treated as owned for connectivity filtering. */
  extraOwnedEdgeIds?: EdgeId[];
  onVertexClick?: (vertexId: VertexId) => void;
  onEdgeClick?: (edgeId: EdgeId) => void;
  onHexClick?: (hexId: string) => void;
}

function hexCornerPoints(center: { x: number; y: number }, size: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const angleRad = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: center.x + size * Math.cos(angleRad), y: center.y + size * Math.sin(angleRad) });
  }
  return pts;
}

/** x-offsets (in dot-spacing units) for a row of `count` evenly-spaced pip dots, centered on
 * 0 — used for the number-token probability pips (1-5 dots depending on the roll). */
function pipDotOffsets(count: number): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(i - (count - 1) / 2);
  return offsets;
}

/** Path for a simple house pictogram (roof + walls, roof peak up), centered on its own
 * origin so it can be positioned purely via a `transform="translate(...)"` on the caller. */
function housePath(halfWidth: number, height: number): string {
  const roofPeakY = -height / 2;
  const shoulderY = roofPeakY + height * 0.42;
  const baseY = height / 2;
  return `M 0,${roofPeakY} L ${halfWidth},${shoulderY} L ${halfWidth},${baseY} L ${-halfWidth},${baseY} L ${-halfWidth},${shoulderY} Z`;
}

/** Lets keyboard/screen-reader users activate an SVG hotspot (role="button") the same way
 * a native <button> would — Enter or Space. */
function activateOnEnterOrSpace(e: KeyboardEvent, activate: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activate();
  }
}

/** Which candidate is currently "armed" (tapped once, previewed, awaiting a second
 * tap/click/Enter on the same spot — or a tap on the confirm badge — to actually commit).
 * Tapping a *different* candidate re-arms on the new one instead of requiring a cancel step. */
type ArmedCandidate = { kind: 'vertex'; id: VertexId } | { kind: 'edge'; id: EdgeId } | null;

/** Small rounded badge + checkmark, positioned near an armed candidate, previewing "this is
 * what you're about to place" and doubling as an explicit confirm tap-target (in addition to
 * tapping the candidate itself again). Kept generic over vertex/edge callers. */
function ConfirmBadge({
  x,
  y,
  label,
  onConfirm,
}: {
  x: number;
  y: number;
  label: string;
  onConfirm: () => void;
}): JSX.Element {
  const w = 30;
  const h = 22;
  return (
    <g
      transform={`translate(${x}, ${y})`}
      className="catan-board__confirm-badge"
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onConfirm();
      }}
      onKeyDown={(e) => activateOnEnterOrSpace(e, onConfirm)}
    >
      <rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={6}
        fill="var(--color-accent)"
        stroke="#1c1c1c"
        strokeWidth={1.5}
      />
      {/* Checkmark */}
      <path
        d="M -8,0 L -2.5,6 L 8,-7"
        fill="none"
        stroke="#1c1c1c"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

// --- Local mirrors of rules.ts legality helpers, scoped to board+room only
// (no hand needed) for client-side candidate filtering. Not authoritative —
// the Firestore transaction is the final check.

function settlementDistanceOk(board: Board, room: RoomState, vertexId: VertexId): boolean {
  if (room.vertices[vertexId]) return false;
  const v = board.vertices[vertexId];
  if (!v) return false;
  return v.adjacentVertexIds.every((n) => !room.vertices[n]);
}

function vertexTouchesOwnRoad(board: Board, room: RoomState, vertexId: VertexId, uid: string): boolean {
  const v = board.vertices[vertexId];
  if (!v) return false;
  return v.adjacentEdgeIds.some((e) => room.edges[e] === uid);
}

function edgeConnectsToOwnNetwork(
  board: Board,
  room: RoomState,
  edgeId: EdgeId,
  uid: string,
  extraOwned: Set<EdgeId>,
): boolean {
  const e = board.edges[edgeId];
  if (!e) return false;
  for (const vId of e.vertexIds) {
    const building = room.vertices[vId];
    if (building && building.uid === uid) return true;
    const v = board.vertices[vId];
    if (v.adjacentEdgeIds.some((other) => other !== edgeId && (room.edges[other] === uid || extraOwned.has(other)))) {
      return true;
    }
  }
  return false;
}

/** Mirrors rules.ts's hexProtectsWeakPlayer: true if a settlement/city on this hex belongs to
 * a player with fewer than 3 visible victory points, making it off-limits for the robber
 * while Safe Mode is on. */
function hexProtectsWeakPlayer(board: Board, room: RoomState, players: Record<string, PublicPlayer>, hexId: string): boolean {
  return Object.values(board.vertices)
    .filter((v) => v.adjacentHexIds.includes(hexId))
    .some((v) => {
      const building = room.vertices[v.id];
      const owner = building && players[building.uid];
      return !!owner && owner.visibleVictoryPoints < 3;
    });
}

export default function BoardView({
  room,
  players,
  uid,
  interactionMode,
  freeSetup,
  extraOwnedEdgeIds,
  onVertexClick,
  onEdgeClick,
  onHexClick,
}: BoardProps): JSX.Element | null {
  const board = room.board;
  const ownColor = uid && players[uid] ? PLAYER_COLOR_HEX[players[uid].color] : 'var(--color-accent)';

  // Two-step tap-to-confirm: the first tap on a candidate "arms" it (shows a preview of the
  // piece plus a confirm badge) without committing; a second tap on that *same* candidate (or
  // the badge, or Enter/Space while it's focused) actually calls onVertexClick/onEdgeClick.
  // Tapping a different candidate re-arms there instead of requiring a cancel step first.
  //
  // This replaces an earlier hover-driven preview (mouseenter/mouseleave on the hotspot)
  // that had a latent staleness bug: a hotspot that disappears out from under the pointer
  // (e.g. the instant its edge/vertex gets built and drops out of the candidate set) never
  // fires `mouseleave`, so the hover id — and the ghost preview keyed off it — could linger
  // indefinitely. Arming is cleared explicitly on commit and whenever the armed id falls out
  // of the current candidate set (below), so it can't go stale the same way.
  const [armed, setArmed] = useState<ArmedCandidate>(null);

  useEffect(() => {
    setArmed(null);
  }, [interactionMode]);

  // --- Click-and-drag / touch-drag panning. The viewBox is translated by `pan` (in the SVG's
  // own user-space units, not screen px) rather than wrapping the content in a CSS transform,
  // so panning composes for free with the existing viewBox-based scaling and doesn't need its
  // own separate coordinate conversion for hit-testing (hotspots stay in the same user-space
  // coordinates either way).
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPan: { x: number; y: number };
    scale: number;
    dragged: boolean;
  } | null>(null);
  // A click fires right after pointerup for the same gesture; if that gesture just panned the
  // board, suppress the one click it would otherwise generate on whatever hotspot happens to
  // sit under the pointer at the drop point (so dragging never accidentally builds/selects).
  const suppressNextClickRef = useRef(false);

  // New board (fresh game) -> forget any prior pan offset.
  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [board]);

  function clampPan(next: { x: number; y: number }): { x: number; y: number } {
    if (!layout) return next;
    // Generous but finite bounds: keeps the board draggable well past its own edges (so you
    // can, e.g., center a corner hex) without letting it disappear off-screen entirely.
    const maxX = layout.width * 0.9;
    const maxY = layout.height * 0.9;
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }

  function handlePointerDown(e: ReactPointerEvent<SVGSVGElement>): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // left-click/primary touch only
    const svg = svgRef.current;
    if (!svg || !layout) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPan: pan,
      scale: layout.width / rect.width, // viewBox user-space units per screen px
      dragged: false,
    };
    // Deliberately not calling setPointerCapture here: capturing eagerly, on every pointerdown
    // including plain taps, retargets the pointerup/click that follows a tap-on-a-hotspot
    // (vertex/edge/hex) to the <svg> itself in some browsers instead of the hotspot underneath
    // the pointer — silently swallowing ordinary build/robber-placement clicks. Capture is only
    // engaged once we've confirmed (in handlePointerMove) that this gesture is actually a drag.
  }

  function handlePointerMove(e: ReactPointerEvent<SVGSVGElement>): void {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dxScreen = e.clientX - drag.startClientX;
    const dyScreen = e.clientY - drag.startClientY;
    if (!drag.dragged) {
      if (Math.hypot(dxScreen, dyScreen) < DRAG_THRESHOLD_PX) return;
      drag.dragged = true;
      setIsPanning(true);
      svgRef.current?.setPointerCapture(e.pointerId);
    }
    // Dragging right/down should move the visible content right/down (follow the pointer),
    // which means the viewBox's own min-x/min-y must move left/up by the same amount.
    setPan(
      clampPan({
        x: drag.startPan.x - dxScreen * drag.scale,
        y: drag.startPan.y - dyScreen * drag.scale,
      }),
    );
  }

  function endDrag(e: ReactPointerEvent<SVGSVGElement>): void {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    if (drag.dragged) suppressNextClickRef.current = true;
    dragRef.current = null;
    setIsPanning(false);
  }

  function handleClickCapture(e: ReactMouseEvent<SVGSVGElement>): void {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }

  // Road-render bug fix (see investigation notes in the PR/commit message): confirming a tap
  // used to call `setArmed(null)` *synchronously*, right before firing onVertexClick/
  // onEdgeClick — which only *starts* the server round trip (submitAction), it doesn't wait
  // for it. That cleared the armed preview (the only thing drawing the piece in the player's
  // own color) immediately, while the real committed piece can't render until room.edges/
  // room.vertices actually reflects the build, which arrives later via the Firestore
  // listener. Between those two points the piece was 100% invisible — not flaky, just a
  // deterministic gap sized by network round-trip time, long enough on a slow connection for
  // a player to notice nothing happened and tap the same spot again, which the server then
  // (correctly) rejects as "already exists" since the first tap's build did land.
  //
  // Fix: don't clear `armed` here at all. Leave the preview showing continuously from the
  // moment of confirmation until the candidate actually falls out of candidateVertices/
  // candidateEdges — which happens in the very same render where the real piece starts being
  // drawn from room.vertices/room.edges (the effect below, keyed on those candidate sets,
  // already existed to un-arm a candidate that disappears for *other* reasons, e.g. another
  // player taking the same spot first; it now also covers this path for free). That
  // guarantees zero gap: the hand-off from "preview" to "real piece" is atomic in React's eyes
  // because both are derived from the same `room` prop update.
  function tapVertex(vertexId: VertexId): void {
    if (armed?.kind === 'vertex' && armed.id === vertexId) {
      onVertexClick?.(vertexId);
    } else {
      setArmed({ kind: 'vertex', id: vertexId });
    }
  }

  function tapEdge(edgeId: EdgeId): void {
    if (armed?.kind === 'edge' && armed.id === edgeId) {
      onEdgeClick?.(edgeId);
    } else {
      setArmed({ kind: 'edge', id: edgeId });
    }
  }

  function confirmArmed(): void {
    if (!armed) return;
    if (armed.kind === 'vertex') onVertexClick?.(armed.id);
    else onEdgeClick?.(armed.id);
  }

  const layout = useMemo(() => {
    if (!board) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const hex of board.hexes) {
      const center = hexPixel(hex.coord, SIZE);
      for (const p of hexCornerPoints(center, SIZE)) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    // Tight enough to still fully contain the port badges (edge midpoint + 30 offset + 16
    // badge radius = 46 beyond the boundary edges, which sit slightly inside the hex-corner
    // bounding box used here) with a small safety margin — every extra unit trimmed here
    // scales the whole board up proportionally within whatever container height is available.
    const pad = 50;
    return {
      minX: minX - pad,
      minY: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }, [board]);

  const candidateVertices = useMemo(() => {
    if (!board || !uid) return new Set<VertexId>();
    const ids = Object.keys(board.vertices);
    if (interactionMode === 'placeSettlement') {
      return new Set(
        ids.filter((id) => {
          if (!settlementDistanceOk(board, room, id)) return false;
          if (freeSetup) return vertexLegalForFogSetup(board, room.discoveredHexIds, id);
          return vertexTouchesOwnRoad(board, room, id, uid);
        }),
      );
    }
    if (interactionMode === 'placeCity') {
      return new Set(ids.filter((id) => room.vertices[id]?.type === 'settlement' && room.vertices[id]?.uid === uid));
    }
    return new Set<VertexId>();
  }, [board, room, uid, interactionMode, freeSetup]);

  const candidateEdges = useMemo(() => {
    if (!board || !uid) return new Set<EdgeId>();
    if (interactionMode !== 'placeRoad') return new Set<EdgeId>();
    const ids = Object.keys(board.edges);
    const extraOwned = new Set(extraOwnedEdgeIds ?? []);
    if (freeSetup) {
      const anchor = room.lastSetupSettlementVertexId;
      if (!anchor) return new Set<EdgeId>();
      return new Set(
        ids.filter((id) => !room.edges[id] && board.edges[id].vertexIds.includes(anchor)),
      );
    }
    return new Set(
      ids.filter((id) => !room.edges[id] && edgeConnectsToOwnNetwork(board, room, id, uid, extraOwned)),
    );
  }, [board, room, uid, interactionMode, freeSetup, extraOwnedEdgeIds]);

  const candidateHexes = useMemo(() => {
    if (!board) return new Set<string>();
    if (interactionMode !== 'placeRobber') return new Set<string>();
    const movable = board.hexes.filter((h) => h.id !== board.robberHexId);
    if (!room.safeMode) return new Set(movable.map((h) => h.id));
    const unprotected = movable.filter((h) => !hexProtectsWeakPlayer(board, room, players, h.id));
    // Fail open, matching the server: if Safe Mode would protect every remaining hex, allow
    // them all rather than soft-locking the robber move entirely.
    return new Set((unprotected.length > 0 ? unprotected : movable).map((h) => h.id));
  }, [board, room, players, interactionMode]);

  // If the armed candidate falls out of the legal set for some other reason (e.g. another
  // player takes the same spot first in a live game), un-arm it rather than leaving a
  // confirm badge pointing at something that's no longer buildable.
  useEffect(() => {
    setArmed((cur) => {
      if (!cur) return cur;
      if (cur.kind === 'vertex' && !candidateVertices.has(cur.id)) return null;
      if (cur.kind === 'edge' && !candidateEdges.has(cur.id)) return null;
      return cur;
    });
  }, [candidateVertices, candidateEdges]);

  if (!board || !layout) return null;

  const viewBox = `${layout.minX - pan.x} ${layout.minY - pan.y} ${layout.width} ${layout.height}`;

  return (
    <svg
      ref={svgRef}
      className="catan-board"
      viewBox={viewBox}
      role="img"
      aria-label="Catan board"
      style={{ cursor: isPanning ? 'grabbing' : 'grab', touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={handleClickCapture}
    >
      <defs>
        {/* Soft dark halo behind roads/settlements/cities so player-colored pieces stay
            legible regardless of what terrain/token color sits directly behind them —
            light colors (white especially) otherwise wash out against fields/pasture
            tiles and the cream number-token circles. */}
        <filter id="piece-shadow" x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0" dy="0" stdDeviation="1.4" floodColor="#000000" floodOpacity="0.65" />
        </filter>
        {/* Sea gradient: ocean (lighter) immediately around the hex/port ring fading out to
            ocean-deep by the edges of this rect — so the water reads as one continuous sea
            with the surrounding .game__board-area (which is already ocean-deep) instead of a
            visibly-bordered rectangle of flat lighter blue floating on top of it. A flat fill
            here left a hard seam exactly at this rect's edge (see Game.css's board-area
            background); the radius is sized so the gradient has already fully reached
            ocean-deep well before the rect's own corners, so the seam disappears. */}
        <radialGradient id="sea-gradient" cx="50%" cy="50%" r="65%">
          <stop offset="0%" style={{ stopColor: 'var(--color-ocean)' }} />
          <stop offset="100%" style={{ stopColor: 'var(--color-ocean-deep)' }} />
        </radialGradient>
      </defs>

      <rect x={layout.minX} y={layout.minY} width={layout.width} height={layout.height} fill="url(#sea-gradient)" />

      {/* Hex tiles */}
      {board.hexes.map((hex) => {
        const center = hexPixel(hex.coord, SIZE);
        const corners = hexCornerPoints(center, SIZE);
        const points = corners.map((p) => `${p.x},${p.y}`).join(' ');
        const isFogged = room.discoveredHexIds !== null && !room.discoveredHexIds.includes(hex.id);
        const isDesert = hex.terrain === 'desert';
        const isGold = hex.terrain === 'gold';
        const fill = isFogged ? FOG_COLOR : isDesert ? DESERT_COLOR : isGold ? GOLD_COLOR : `var(--resource-${TERRAIN_RESOURCE[hex.terrain as Exclude<Terrain, 'desert' | 'gold'>]})`;
        const isHotHex = hex.number === 6 || hex.number === 8;
        // Non-desert/gold/fog tiles also carry a number token dead center, so the terrain
        // icon sits lower as a small grounded badge instead of a large image competing with
        // the number — desert/gold/fog have no number token (fog's is simply unknown yet),
        // so their icon/glyph can stay centered and a bit larger.
        const centeredIcon = isDesert || isGold || isFogged;
        // The card-style resource art (RESOURCE_ICON, shared with the hand/bank/trade UI) has
        // a lot more transparent padding baked into the source PNG than the old terrain badge
        // art did, so it needs a noticeably larger box to read at the same visual size — the
        // desert's own dedicated icon keeps the old centered sizing.
        const iconSize = centeredIcon ? SIZE * 1.05 : SIZE * 0.98;
        const iconCenterY = centeredIcon ? center.y : center.y + SIZE * 0.5;
        return (
          <g key={hex.id}>
            <polygon points={points} fill={fill} stroke="var(--color-ocean-deep)" strokeWidth={2} />
            {!centeredIcon && (
              <circle cx={center.x} cy={iconCenterY} r={iconSize * 0.36} fill="rgba(0,0,0,0.16)" />
            )}
            {isFogged ? (
              <text
                x={center.x}
                y={iconCenterY + 11}
                textAnchor="middle"
                fontSize={32}
                fontWeight={700}
                fill="rgba(255,255,255,0.3)"
                style={{ pointerEvents: 'none' }}
              >
                ?
              </text>
            ) : isGold ? (
              <text x={center.x} y={iconCenterY + 12} textAnchor="middle" fontSize={34} style={{ pointerEvents: 'none' }}>
                ✨
              </text>
            ) : isDesert ? (
              <image
                href={desertIcon}
                x={center.x - iconSize / 2}
                y={iconCenterY - iconSize / 2}
                width={iconSize}
                height={iconSize}
                style={{ pointerEvents: 'none' }}
                preserveAspectRatio="xMidYMid meet"
              />
            ) : (
              // Card-style resource icon (shared with the hand/bank/trade UI) instead of the
              // old terrain-specific badge art, so the same visual language is used everywhere
              // a resource is depicted.
              <image
                href={RESOURCE_ICON[TERRAIN_RESOURCE[hex.terrain as Exclude<Terrain, 'desert' | 'gold'>]]}
                x={center.x - iconSize / 2}
                y={iconCenterY - iconSize / 2}
                width={iconSize}
                height={iconSize}
                style={{ pointerEvents: 'none' }}
                preserveAspectRatio="xMidYMid meet"
              />
            )}
            {hex.number !== null && (
              <g>
                <circle
                  cx={center.x}
                  cy={center.y + NUMBER_TOKEN_Y_OFFSET}
                  r={18}
                  fill="#f4e8cf"
                  stroke="#2b2015"
                  strokeWidth={1.5}
                />
                <text
                  x={center.x}
                  y={center.y + NUMBER_TOKEN_Y_OFFSET + 6}
                  textAnchor="middle"
                  fontSize={16}
                  fontWeight={700}
                  fill={isHotHex ? '#c0392b' : '#2b2015'}
                >
                  {hex.number}
                </text>
                {/* Probability pips as real dots rather than a tiny bullet-character string —
                    reads more clearly at a glance, especially for the 4-5 pip hot numbers. */}
                {pipDotOffsets(pipCount(hex.number)).map((offset, i) => (
                  <circle
                    key={i}
                    cx={center.x + offset * 4.6}
                    cy={center.y + NUMBER_TOKEN_Y_OFFSET + 14}
                    r={1.8}
                    fill={isHotHex ? '#c0392b' : '#6b5b3a'}
                  />
                ))}
              </g>
            )}
            {hex.id === board.robberHexId && (
              <>
                {/* Dim the blocked hex so "this tile produces nothing" reads at a glance,
                    not just from spotting the badge. */}
                <polygon points={points} fill="rgba(8, 10, 18, 0.38)" style={{ pointerEvents: 'none' }} />
                <g
                  transform={`translate(${center.x + SIZE * 0.42}, ${center.y - SIZE * 0.5})`}
                  data-testid="robber"
                  data-hex-id={hex.id}
                >
                  <circle r={20} fill="rgba(0, 0, 0, 0.45)" />
                  <circle r={17} fill="#1c1c1c" stroke="#e8e9ec" strokeWidth={2.5} />
                  <image
                    href={robberIcon}
                    x={-15}
                    y={-15}
                    width={30}
                    height={30}
                    style={{ pointerEvents: 'none' }}
                    preserveAspectRatio="xMidYMid meet"
                  />
                </g>
              </>
            )}
          </g>
        );
      })}

      {/* Ports */}
      {board.ports.map((port) => {
        const [va, vb] = port.vertexIds;
        const pa = vertexPixel(va, board, SIZE);
        const pb = vertexPixel(vb, board, SIZE);
        const mx = (pa.x + pb.x) / 2;
        const my = (pa.y + pb.y) / 2;
        const dist = Math.hypot(mx, my) || 1;
        const ox = mx + (mx / dist) * 30;
        const oy = my + (my / dist) * 30;
        return (
          <g key={port.id}>
            {/* Two piers, one to each vertex the port actually serves — a single line to
                the edge midpoint read as "attached to a hex side" rather than "attached to
                the two corners a settlement there can use." */}
            <line x1={pa.x} y1={pa.y} x2={ox} y2={oy} stroke="var(--color-text-dim)" strokeWidth={2} />
            <line x1={pb.x} y1={pb.y} x2={ox} y2={oy} stroke="var(--color-text-dim)" strokeWidth={2} />
            <circle cx={ox} cy={oy} r={16} fill="var(--color-panel)" stroke="var(--color-border)" strokeWidth={1.5} />
            {port.type === 'generic' ? (
              <text x={ox} y={oy + 4} textAnchor="middle" fontSize={9} fill="var(--color-text)">
                3:1
              </text>
            ) : (
              <>
                <image
                  href={RESOURCE_ICON[port.type]}
                  x={ox - 9}
                  y={oy - 11}
                  width={18}
                  height={18}
                  style={{ pointerEvents: 'none' }}
                  preserveAspectRatio="xMidYMid meet"
                />
                <text x={ox} y={oy + 13} textAnchor="middle" fontSize={7} fill="var(--color-text)">
                  2:1
                </text>
              </>
            )}
          </g>
        );
      })}

      {/* Roads. A dark outline renders underneath every road regardless of owner color —
          without it, a green road (#2f7a3d) is the exact same hex as the forest tile fill
          (--resource-lumber, also #2f7a3d) and disappears entirely against it. */}
      {Object.entries(room.edges).map(([edgeId, ownerUid]) => {
        const edgeInfo = board.edges[edgeId];
        // Defensive only: `room.board` is set once by createGame and never reassigned/
        // regenerated for a live room (verified — no rematch/board-regen code path exists,
        // and buildRoad/playRoadBuilding in rules.ts both validate action.edgeId against
        // board.edges before ever writing room.edges[edgeId]), so this should be unreachable
        // in practice. Left in rather than removed in case that invariant ever changes.
        if (!edgeInfo) return null;
        const [a, b] = edgeInfo.vertexIds;
        const pa = vertexPixel(a, board, SIZE);
        const pb = vertexPixel(b, board, SIZE);
        const color = players[ownerUid] ? PLAYER_COLOR_HEX[players[ownerUid].color] : '#888';
        return (
          // data-testid/data-owner-uid: test-only hooks (e2e/latency-fuzz.spec.ts's oracle) for
          // verifying every committed room.edges entry has exactly one correctly-colored
          // rendered road and no phantom roads exist — purely additive, no visual/behavioral
          // change.
          //
          // Deliberately NOT using the piece-shadow filter (see settlements/cities below) —
          // that filter's region is defined in objectBoundingBox percentages, and a perfectly
          // vertical edge (x1 === x2, which a real fraction of hex edges are) gives its <g> a
          // geometrically zero-width bounding box. Per the SVG spec, a percentage-based filter
          // region computed against a zero-width (or zero-height) bounding box is invalid,
          // and browsers respond by rendering the filtered element as nothing at all — not a
          // squished shadow, the *entire* road disappears despite the DOM/data being entirely
          // correct. Settlements/cities are 2D house shapes with nonzero extent in both
          // dimensions no matter their position, so they're not at risk; roads already have a
          // hard dark outline (the wider #1c1c1c line underneath) for the same
          // terrain-contrast legibility the filter was providing elsewhere, so dropping it
          // here loses only the soft blur, not the legibility itself.
          <g key={edgeId} data-testid={`road-${edgeId}`} data-owner-uid={ownerUid}>
            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="#1c1c1c" strokeWidth={11} strokeLinecap="round" />
            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={color} strokeWidth={5} strokeLinecap="round" />
          </g>
        );
      })}

      {/* Road Building preview: edges picked-but-not-yet-dispatched (the first of the two
          edges the card grants, stashed in Game.tsx's local state and passed down as
          extraOwnedEdgeIds) don't exist in room.edges yet — nothing above would render them —
          so render them here as a same-style-as-committed, own-color preview. This mirrors the
          armed-candidate preview pattern below (own color, not yet server-confirmed) rather
          than leaving the first pick invisible until the second edge is also chosen. */}
      {extraOwnedEdgeIds?.map((edgeId) => {
        if (room.edges[edgeId]) return null; // already committed/rendered above
        const edgeInfo = board.edges[edgeId];
        if (!edgeInfo) return null;
        const [a, b] = edgeInfo.vertexIds;
        const pa = vertexPixel(a, board, SIZE);
        const pb = vertexPixel(b, board, SIZE);
        return (
          // No piece-shadow filter here either — see the committed-road comment above for why
          // (a perfectly vertical edge's zero-width bounding box breaks the filter's
          // percentage-based region entirely, not just its blur).
          <g key={`pending-${edgeId}`} opacity={0.85} data-testid={`road-preview-${edgeId}`}>
            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="#1c1c1c" strokeWidth={11} strokeLinecap="round" />
            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={ownColor} strokeWidth={5} strokeLinecap="round" />
          </g>
        );
      })}

      {/* Settlements & cities. Sized up and outlined heavier than a first pass, plus the
          drop-shadow filter above — smaller/thinner versions of these were hard to spot at
          a glance, especially light colors (white) against light terrain. */}
      {Object.entries(room.vertices).map(([vertexId, building]) => {
        const p = vertexPixel(vertexId, board, SIZE);
        const color = players[building.uid] ? PLAYER_COLOR_HEX[players[building.uid].color] : '#888';
        if (building.type === 'city') {
          return (
            <g
              key={vertexId}
              transform={`translate(${p.x}, ${p.y})`}
              filter="url(#piece-shadow)"
              data-testid={`building-${vertexId}`}
              data-owner-uid={building.uid}
              data-building-type="city"
            >
              {/* City: a taller main house plus a smaller wing, reading as "grown" from a
                  single settlement house without needing a second color/legend. */}
              <path d={housePath(7.5, 12.5)} transform="translate(-3.5, -1)" fill={color} stroke="#1c1c1c" strokeWidth={2} />
              <path d={housePath(5.5, 9)} transform="translate(7, 2.5)" fill={color} stroke="#1c1c1c" strokeWidth={1.8} />
            </g>
          );
        }
        return (
          <path
            key={vertexId}
            d={housePath(8, 11)}
            filter="url(#piece-shadow)"
            transform={`translate(${p.x}, ${p.y})`}
            fill={color}
            stroke="#1c1c1c"
            strokeWidth={2}
            data-testid={`building-${vertexId}`}
            data-owner-uid={building.uid}
            data-building-type="settlement"
          />
        );
      })}

      {/* Interaction hotspots. Every candidate pulses continuously (not just on hover) so
          legal placements are visible at a glance; the first tap "arms" one (see the preview
          + confirm-badge block below) rather than building immediately. */}
      {interactionMode === 'placeSettlement' &&
        Array.from(candidateVertices).map((vid) => {
          const p = vertexPixel(vid, board, SIZE);
          const isArmed = armed?.kind === 'vertex' && armed.id === vid;
          return (
            <circle
              key={`hot-${vid}`}
              cx={p.x}
              cy={p.y}
              r={9}
              className={`catan-board__hotspot catan-board__hotspot--vertex${isArmed ? ' catan-board__hotspot--armed' : ' catan-board__hotspot--pulse'}`}
              onClick={() => tapVertex(vid)}
              role="button"
              tabIndex={0}
              aria-label={isArmed ? 'Confirm settlement here' : 'Build settlement here'}
              aria-pressed={isArmed}
              data-testid={`hotspot-vertex-${vid}`}
              onKeyDown={(e) => activateOnEnterOrSpace(e, () => tapVertex(vid))}
            />
          );
        })}

      {interactionMode === 'placeCity' &&
        Array.from(candidateVertices).map((vid) => {
          const p = vertexPixel(vid, board, SIZE);
          const isArmed = armed?.kind === 'vertex' && armed.id === vid;
          return (
            <circle
              key={`hot-${vid}`}
              cx={p.x}
              cy={p.y}
              r={12}
              className={`catan-board__hotspot catan-board__hotspot--vertex${isArmed ? ' catan-board__hotspot--armed' : ' catan-board__hotspot--pulse'}`}
              onClick={() => tapVertex(vid)}
              role="button"
              tabIndex={0}
              aria-label={isArmed ? 'Confirm city upgrade here' : 'Upgrade to city here'}
              aria-pressed={isArmed}
              data-testid={`hotspot-vertex-${vid}`}
              onKeyDown={(e) => activateOnEnterOrSpace(e, () => tapVertex(vid))}
            />
          );
        })}

      {interactionMode === 'placeRoad' &&
        Array.from(candidateEdges).map((eid) => {
          const edgeInfo = board.edges[eid];
          const mid = edgeMidpoint(eid, board, SIZE);
          const [a, b] = edgeInfo.vertexIds;
          const pa = vertexPixel(a, board, SIZE);
          const pb = vertexPixel(b, board, SIZE);
          const isArmed = armed?.kind === 'edge' && armed.id === eid;
          return (
            <g
              key={`hot-${eid}`}
              onClick={() => tapEdge(eid)}
              role="button"
              tabIndex={0}
              aria-label={isArmed ? 'Confirm road here' : 'Build road here'}
              aria-pressed={isArmed}
              data-testid={`hotspot-edge-${eid}`}
              onKeyDown={(e) => activateOnEnterOrSpace(e, () => tapEdge(eid))}
            >
              <line
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                className={`catan-board__hotspot catan-board__hotspot--edge${isArmed ? ' catan-board__hotspot--edge-armed' : ' catan-board__hotspot--edge-pulse'}`}
                strokeWidth={14}
                strokeLinecap="round"
              />
              {/* The actual click target above is the full-length line (easier to hit); this
                  small bubble at the midpoint is the "pulsing dot in the middle of the road"
                  visual affordance requested — purely decorative, so pointer-events stay off
                  it and clicks fall through to the line/group underneath. */}
              {!isArmed && (
                <circle
                  cx={mid.x}
                  cy={mid.y}
                  r={5}
                  fill="var(--color-accent)"
                  stroke="#1c1c1c"
                  strokeWidth={1}
                  className="catan-board__pulse-bubble"
                  style={{ pointerEvents: 'none' }}
                />
              )}
            </g>
          );
        })}

      {/* Armed preview: the actual piece, solid-ish in the player's own color, at whatever
          candidate is currently armed — plus a confirm badge next to it. Drawn last (on top)
          so it's never occluded; the piece preview itself is pointer-events-none (the
          hotspot underneath still owns the click/tap-again-to-confirm), but the badge is a
          real, independently focusable/clickable confirm control. */}
      {armed?.kind === 'vertex' &&
        (() => {
          const p = vertexPixel(armed.id, board, SIZE);
          const size = interactionMode === 'placeCity' ? housePath(7.5, 12.5) : housePath(8, 11);
          return (
            <g key="armed-vertex-preview" data-testid="armed-preview-vertex" data-armed-id={armed.id}>
              <path
                d={size}
                transform={`translate(${p.x}, ${p.y})`}
                fill={ownColor}
                stroke="#1c1c1c"
                strokeWidth={2}
                opacity={0.85}
                style={{ pointerEvents: 'none' }}
              />
              <ConfirmBadge
                x={p.x + 26}
                y={p.y - 26}
                label={interactionMode === 'placeCity' ? 'Confirm city upgrade' : 'Confirm settlement'}
                onConfirm={confirmArmed}
              />
            </g>
          );
        })()}

      {armed?.kind === 'edge' &&
        (() => {
          const edgeInfo = board.edges[armed.id];
          const pa = vertexPixel(edgeInfo.vertexIds[0], board, SIZE);
          const pb = vertexPixel(edgeInfo.vertexIds[1], board, SIZE);
          const mid = edgeMidpoint(armed.id, board, SIZE);
          return (
            <g key="armed-edge-preview" data-testid="armed-preview-edge" data-armed-id={armed.id}>
              <line
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                stroke={ownColor}
                strokeWidth={5}
                strokeLinecap="round"
                opacity={0.85}
                style={{ pointerEvents: 'none' }}
              />
              <ConfirmBadge x={mid.x} y={mid.y - 28} label="Confirm road" onConfirm={confirmArmed} />
            </g>
          );
        })()}

      {interactionMode === 'placeRobber' &&
        board.hexes
          .filter((h) => candidateHexes.has(h.id))
          .map((hex) => {
            const center = hexPixel(hex.coord, SIZE);
            const points = hexCornerPoints(center, SIZE)
              .map((p) => `${p.x},${p.y}`)
              .join(' ');
            return (
              <polygon
                key={`hot-${hex.id}`}
                points={points}
                className="catan-board__hotspot catan-board__hotspot--hex"
                onClick={() => onHexClick?.(hex.id)}
                role="button"
                tabIndex={0}
                aria-label="Move the robber to this hex"
                data-testid={`hotspot-hex-${hex.id}`}
                onKeyDown={(e) => activateOnEnterOrSpace(e, () => onHexClick?.(hex.id))}
              />
            );
          })}
    </svg>
  );
}
