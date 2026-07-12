import { useMemo, type JSX } from 'react';
import type { Board, EdgeId, PublicPlayer, RoomState, Terrain, VertexId } from '../game/types';
import { TERRAIN_RESOURCE } from '../game/types';
import { edgeMidpoint, hexPixel, pipCount, vertexPixel } from '../game/board';
import { PLAYER_COLOR_HEX } from './playerColors';
import './Board.css';

const SIZE = 56;

const TERRAIN_ICON: Record<Terrain, string> = {
  hills: '🧱',
  forest: '🌲',
  mountains: '⛰️',
  fields: '🌾',
  pasture: '🐑',
  desert: '',
};

const DESERT_COLOR = '#c9b57a';

const RESOURCE_ICON: Record<string, string> = {
  brick: '🧱',
  lumber: '🌲',
  ore: '⛰️',
  grain: '🌾',
  wool: '🐑',
};

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
    const pad = 60;
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
      <rect x={layout.minX} y={layout.minY} width={layout.width} height={layout.height} fill="var(--color-ocean)" />

      {/* Hex tiles */}
      {board.hexes.map((hex) => {
        const center = hexPixel(hex.coord, SIZE);
        const corners = hexCornerPoints(center, SIZE);
        const points = corners.map((p) => `${p.x},${p.y}`).join(' ');
        const fill = hex.terrain === 'desert' ? DESERT_COLOR : `var(--resource-${TERRAIN_RESOURCE[hex.terrain]})`;
        const isHotHex = hex.number === 6 || hex.number === 8;
        return (
          <g key={hex.id}>
            <polygon points={points} fill={fill} stroke="var(--color-ocean-deep)" strokeWidth={2} />
            {hex.terrain !== 'desert' && (
              <text x={center.x} y={center.y - SIZE * 0.45} textAnchor="middle" fontSize={16} className="catan-board__terrain-icon">
                {TERRAIN_ICON[hex.terrain]}
              </text>
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
                <circle r={10} fill="#1c1c1c" stroke="#e8e9ec" strokeWidth={1.5} />
                <text textAnchor="middle" y={4} fontSize={11}>
                  🥷
                </text>
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
        const label = port.type === 'generic' ? '3:1' : `2:1 ${RESOURCE_ICON[port.type] ?? port.type}`;
        return (
          <g key={port.id}>
            <line x1={mx} y1={my} x2={ox} y2={oy} stroke="var(--color-text-dim)" strokeWidth={2} />
            <circle cx={ox} cy={oy} r={16} fill="var(--color-panel)" stroke="var(--color-border)" strokeWidth={1.5} />
            <text x={ox} y={oy + 4} textAnchor="middle" fontSize={9} fill="var(--color-text)">
              {label}
            </text>
          </g>
        );
      })}

      {/* Roads */}
      {Object.entries(room.edges).map(([edgeId, ownerUid]) => {
        const edgeInfo = board.edges[edgeId];
        if (!edgeInfo) return null;
        const [a, b] = edgeInfo.vertexIds;
        const pa = vertexPixel(a, board, SIZE);
        const pb = vertexPixel(b, board, SIZE);
        const color = players[ownerUid] ? PLAYER_COLOR_HEX[players[ownerUid].color] : '#888';
        return (
          <line
            key={edgeId}
            x1={pa.x}
            y1={pa.y}
            x2={pb.x}
            y2={pb.y}
            stroke={color}
            strokeWidth={6}
            strokeLinecap="round"
          />
        );
      })}

      {/* Settlements & cities */}
      {Object.entries(room.vertices).map(([vertexId, building]) => {
        const p = vertexPixel(vertexId, board, SIZE);
        const color = players[building.uid] ? PLAYER_COLOR_HEX[players[building.uid].color] : '#888';
        if (building.type === 'city') {
          return (
            <g key={vertexId}>
              <circle cx={p.x} cy={p.y} r={11} fill={color} stroke="#1c1c1c" strokeWidth={1.5} />
              <circle cx={p.x} cy={p.y} r={4.5} fill="var(--color-panel)" />
            </g>
          );
        }
        return <circle key={vertexId} cx={p.x} cy={p.y} r={7} fill={color} stroke="#1c1c1c" strokeWidth={1.5} />;
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
            <g key={`hot-${eid}`} onClick={() => onEdgeClick?.(eid)}>
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
              />
            );
          })}
    </svg>
  );
}
