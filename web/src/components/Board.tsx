import { useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import type { Board, EdgeId, PublicPlayer, RoomState, Terrain, VertexId } from '@catan/engine';
import { TERRAIN_RESOURCE } from '@catan/engine';
import { edgeMidpoint, hexPixel, pipCount, vertexPixel } from '@catan/engine';
import { PLAYER_COLOR_HEX } from './playerColors';
import { RESOURCE_ICON } from './resourceIcons';
import hillsIcon from '../assets/terrain/hills.png';
import forestIcon from '../assets/terrain/forest.png';
import mountainsIcon from '../assets/terrain/mountains.png';
import fieldsIcon from '../assets/terrain/fields.png';
import pastureIcon from '../assets/terrain/pasture.png';
import desertIcon from '../assets/terrain/desert.png';
import robberIcon from '../assets/terrain/robber.png';
import './Board.css';

const SIZE = 56;

const TERRAIN_ICON: Record<Exclude<Terrain, 'gold'>, string> = {
  hills: hillsIcon,
  forest: forestIcon,
  mountains: mountainsIcon,
  fields: fieldsIcon,
  pasture: pastureIcon,
  desert: desertIcon,
};

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

  // Hover preview: show the actual piece (ghosted, in the player's own color) at whatever
  // candidate vertex/edge the pointer is over, not just a generic highlighted hotspot.
  const [hoverVertexId, setHoverVertexId] = useState<VertexId | null>(null);
  const [hoverEdgeId, setHoverEdgeId] = useState<EdgeId | null>(null);
  const previewVertexId =
    interactionMode === 'placeSettlement' || interactionMode === 'placeCity' ? hoverVertexId : null;
  const previewEdgeId = interactionMode === 'placeRoad' ? hoverEdgeId : null;

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
          if (freeSetup) return true;
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
    return new Set(board.hexes.filter((h) => h.id !== board.robberHexId).map((h) => h.id));
  }, [board, interactionMode]);

  if (!board || !layout) return null;

  const viewBox = `${layout.minX} ${layout.minY} ${layout.width} ${layout.height}`;

  return (
    <svg className="catan-board" viewBox={viewBox} role="img" aria-label="Catan board">
      <defs>
        {/* Soft dark halo behind roads/settlements/cities so player-colored pieces stay
            legible regardless of what terrain/token color sits directly behind them —
            light colors (white especially) otherwise wash out against fields/pasture
            tiles and the cream number-token circles. */}
        <filter id="piece-shadow" x="-60%" y="-60%" width="220%" height="220%">
          <feDropShadow dx="0" dy="0" stdDeviation="1.4" floodColor="#000000" floodOpacity="0.65" />
        </filter>
      </defs>

      <rect x={layout.minX} y={layout.minY} width={layout.width} height={layout.height} fill="var(--color-ocean)" />

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
        const iconSize = centeredIcon ? SIZE * 1.05 : SIZE * 0.62;
        const iconCenterY = centeredIcon ? center.y : center.y + SIZE * 0.54;
        return (
          <g key={hex.id}>
            <polygon points={points} fill={fill} stroke="var(--color-ocean-deep)" strokeWidth={2} />
            {!centeredIcon && (
              <circle cx={center.x} cy={iconCenterY} r={iconSize * 0.56} fill="rgba(0,0,0,0.16)" />
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
            ) : (
              <image
                href={TERRAIN_ICON[hex.terrain as Exclude<Terrain, 'gold'>]}
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
                <circle cx={center.x} cy={center.y} r={18} fill="#f4e8cf" stroke="#2b2015" strokeWidth={1.5} />
                <text
                  x={center.x}
                  y={center.y + 6}
                  textAnchor="middle"
                  fontSize={16}
                  fontWeight={700}
                  fill={isHotHex ? '#c0392b' : '#2b2015'}
                >
                  {hex.number}
                </text>
                <text x={center.x} y={center.y + 16} textAnchor="middle" fontSize={7} letterSpacing={1} fill="#6b5b3a">
                  {'•'.repeat(pipCount(hex.number))}
                </text>
              </g>
            )}
            {hex.id === board.robberHexId && (
              <g transform={`translate(${center.x + SIZE * 0.42}, ${center.y - SIZE * 0.5})`}>
                <circle r={14} fill="#1c1c1c" stroke="#e8e9ec" strokeWidth={1.5} />
                <image
                  href={robberIcon}
                  x={-12}
                  y={-12}
                  width={24}
                  height={24}
                  style={{ pointerEvents: 'none' }}
                  preserveAspectRatio="xMidYMid meet"
                />
              </g>
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
        if (!edgeInfo) return null;
        const [a, b] = edgeInfo.vertexIds;
        const pa = vertexPixel(a, board, SIZE);
        const pb = vertexPixel(b, board, SIZE);
        const color = players[ownerUid] ? PLAYER_COLOR_HEX[players[ownerUid].color] : '#888';
        return (
          <g key={edgeId} filter="url(#piece-shadow)">
            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="#1c1c1c" strokeWidth={11} strokeLinecap="round" />
            <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={color} strokeWidth={5} strokeLinecap="round" />
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
            <g key={vertexId} transform={`translate(${p.x}, ${p.y})`} filter="url(#piece-shadow)">
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
          />
        );
      })}

      {/* Interaction hotspots */}
      {interactionMode === 'placeSettlement' &&
        Array.from(candidateVertices).map((vid) => {
          const p = vertexPixel(vid, board, SIZE);
          return (
            <circle
              key={`hot-${vid}`}
              cx={p.x}
              cy={p.y}
              r={9}
              className="catan-board__hotspot catan-board__hotspot--vertex"
              onClick={() => onVertexClick?.(vid)}
              onMouseEnter={() => setHoverVertexId(vid)}
              onMouseLeave={() => setHoverVertexId((cur) => (cur === vid ? null : cur))}
              role="button"
              tabIndex={0}
              aria-label="Build settlement here"
              onKeyDown={(e) => activateOnEnterOrSpace(e, () => onVertexClick?.(vid))}
            />
          );
        })}

      {interactionMode === 'placeCity' &&
        Array.from(candidateVertices).map((vid) => {
          const p = vertexPixel(vid, board, SIZE);
          return (
            <circle
              key={`hot-${vid}`}
              cx={p.x}
              cy={p.y}
              r={12}
              className="catan-board__hotspot catan-board__hotspot--vertex"
              onClick={() => onVertexClick?.(vid)}
              onMouseEnter={() => setHoverVertexId(vid)}
              onMouseLeave={() => setHoverVertexId((cur) => (cur === vid ? null : cur))}
              role="button"
              tabIndex={0}
              aria-label="Upgrade to city here"
              onKeyDown={(e) => activateOnEnterOrSpace(e, () => onVertexClick?.(vid))}
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
          return (
            <g
              key={`hot-${eid}`}
              onClick={() => onEdgeClick?.(eid)}
              onMouseEnter={() => setHoverEdgeId(eid)}
              onMouseLeave={() => setHoverEdgeId((cur) => (cur === eid ? null : cur))}
              role="button"
              tabIndex={0}
              aria-label="Build road here"
              onKeyDown={(e) => activateOnEnterOrSpace(e, () => onEdgeClick?.(eid))}
            >
              <line
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                className="catan-board__hotspot catan-board__hotspot--edge"
                strokeWidth={14}
                strokeLinecap="round"
              />
              <circle cx={mid.x} cy={mid.y} r={3} fill="var(--color-accent)" opacity={0.001} />
            </g>
          );
        })}

      {/* Hover preview: the actual piece, ghosted, in the player's own color — drawn last
          (on top) and pointer-events-none so it never steals the hotspot's own hover/click. */}
      {previewVertexId &&
        (() => {
          const p = vertexPixel(previewVertexId, board, SIZE);
          const size = interactionMode === 'placeCity' ? housePath(7.5, 12.5) : housePath(8, 11);
          return (
            <path
              d={size}
              transform={`translate(${p.x}, ${p.y})`}
              fill={ownColor}
              stroke="#1c1c1c"
              strokeWidth={2}
              opacity={0.55}
              style={{ pointerEvents: 'none' }}
            />
          );
        })()}

      {previewEdgeId &&
        (() => {
          const edgeInfo = board.edges[previewEdgeId];
          const pa = vertexPixel(edgeInfo.vertexIds[0], board, SIZE);
          const pb = vertexPixel(edgeInfo.vertexIds[1], board, SIZE);
          return (
            <line
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              stroke={ownColor}
              strokeWidth={5}
              strokeLinecap="round"
              opacity={0.55}
              style={{ pointerEvents: 'none' }}
            />
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
                onKeyDown={(e) => activateOnEnterOrSpace(e, () => onHexClick?.(hex.id))}
              />
            );
          })}
    </svg>
  );
}
