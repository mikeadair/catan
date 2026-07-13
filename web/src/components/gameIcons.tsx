// Small inline-SVG icon set shared by the build toolbar, bank panel, and player roster —
// replaces emoji (inconsistent rendering across platforms/fonts) with icons that inherit
// `currentColor`, so they follow button/text color automatically.
import type { JSX, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps): IconProps {
  return { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, ...props };
}

export function RoadIcon(props: IconProps): JSX.Element {
  return (
    <svg {...base(props)}>
      <line x1="5" y1="19" x2="19" y2="5" stroke="currentColor" strokeWidth={4} strokeLinecap="round" />
      <line x1="5" y1="19" x2="19" y2="5" stroke="var(--color-panel)" strokeWidth={1.4} strokeDasharray="2.5 3" strokeLinecap="round" />
    </svg>
  );
}

export function SettlementIcon(props: IconProps): JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 3 L20 10 V20 H4 V10 Z" fill="currentColor" stroke="currentColor" strokeWidth={1} strokeLinejoin="round" />
    </svg>
  );
}

export function CityIcon(props: IconProps): JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 21 V12 L8 8 L13 12 V21 Z" fill="currentColor" opacity={0.85} />
      <path d="M11 21 V6 L18 1 L21 6 V21 Z" fill="currentColor" />
    </svg>
  );
}

export function DevCardIcon(props: IconProps): JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="4" y="2" width="13" height="18" rx="2" transform="rotate(8 10.5 11)" fill="currentColor" opacity={0.55} />
      <rect x="6" y="4" width="13" height="18" rx="2" fill="currentColor" />
      <circle cx="12.5" cy="13" r="3.4" fill="var(--color-panel)" />
    </svg>
  );
}

export function TradeIcon(props: IconProps): JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 8 H17 M17 8 L13 4 M17 8 L13 12" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M20 16 H7 M7 16 L11 12 M7 16 L11 20" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function ResourceCardsIcon(props: IconProps): JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="2" y="6" width="12" height="16" rx="1.5" transform="rotate(-10 8 14)" fill="currentColor" opacity={0.55} />
      <rect x="8" y="5" width="12" height="16" rx="1.5" fill="currentColor" />
    </svg>
  );
}

export function VictoryPointIcon(props: IconProps): JSX.Element {
  return (
    <svg {...base(props)}>
      <path
        d="M12 2 L14.7 8.6 L22 9.3 L16.5 14 L18.2 21.2 L12 17.3 L5.8 21.2 L7.5 14 L2 9.3 L9.3 8.6 Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function KnightIcon(props: IconProps): JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 2 L19 5.5 V11 C19 16 16 19.5 12 22 C8 19.5 5 16 5 11 V5.5 Z" fill="currentColor" opacity={0.85} />
      <path d="M12 6 L15 9 L12 18 L9 9 Z" fill="var(--color-panel)" />
    </svg>
  );
}

export function LargestArmyIcon(props: IconProps): JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="M12 6 L14.2 10.6 L19 11.3 L15.5 14.6 L16.4 19.3 L12 17 L7.6 19.3 L8.5 14.6 L5 11.3 L9.8 10.6 Z" fill="var(--color-panel)" />
    </svg>
  );
}

export function LongestRoadIcon(props: IconProps): JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <line x1="7" y1="16" x2="17" y2="8" stroke="var(--color-panel)" strokeWidth={2.6} strokeLinecap="round" />
    </svg>
  );
}
