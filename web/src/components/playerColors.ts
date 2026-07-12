// Shared player-color swatch mapping, used by Board, PlayerRoster, and anywhere
// else that needs to render a PublicPlayer's color as a CSS color.
import type { PlayerColor } from '@catan/engine';

export const PLAYER_COLOR_HEX: Record<PlayerColor, string> = {
  red: '#c0392b',
  blue: '#2d6cdf',
  white: '#e8e9ec',
  orange: '#e07b1f',
  green: '#2f7a3d',
  brown: '#7a5230',
};
