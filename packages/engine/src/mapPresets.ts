import type { MapPreset } from './types';

export const MAP_PRESETS: MapPreset[] = [
  {
    id: 'official-beginner',
    name: 'Official Beginner',
    description: 'The fixed classic tile, number, and port layout recommended for a first game.',
  },
  {
    id: 'balanced-random',
    name: 'Balanced Random',
    description: 'Shuffled terrain, numbers, and ports, reshuffled until no two 6/8 tokens are adjacent.',
  },
  {
    id: 'chaos',
    name: 'Chaos',
    description: 'Fully random terrain, numbers, and ports with no fairness constraints.',
  },
  {
    id: 'extended-5-6p',
    name: '5-6 Player Extension',
    description: 'A larger 30-hex board for 5-6 players. Terrain and numbers are randomized (fairly), same as Balanced Random.',
  },
  {
    id: 'fog-of-war',
    name: 'Fog of War',
    description:
      'Only the outer ring is known at the start, plus a gold tile at the very center — the hidden inner ring reveals (with a freshly random number) as your roads reach it, granting a resource on discovery. The gold tile lets whoever rolls it pick their own resource, but can\'t be settled on at setup.',
  },
];
