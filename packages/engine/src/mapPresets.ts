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
];
