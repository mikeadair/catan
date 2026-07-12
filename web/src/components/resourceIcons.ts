import type { Resource } from '@catan/engine';
import brickIcon from '../assets/resources/brick.png';
import lumberIcon from '../assets/resources/lumber.png';
import oreIcon from '../assets/resources/ore.png';
import grainIcon from '../assets/resources/grain.png';
import woolIcon from '../assets/resources/wool.png';

export const RESOURCE_ICON: Record<Resource, string> = {
  brick: brickIcon,
  lumber: lumberIcon,
  ore: oreIcon,
  grain: grainIcon,
  wool: woolIcon,
};

export const RESOURCE_LABEL: Record<Resource, string> = {
  brick: 'Brick',
  lumber: 'Lumber',
  ore: 'Ore',
  grain: 'Grain',
  wool: 'Wool',
};
