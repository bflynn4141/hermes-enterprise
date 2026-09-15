// The glass icon kit, ported verbatim from the demo. It stays, and it replaces
// `iconoir-react` wherever `@hermes/motion-components` reaches for one (plan
// §10b, pre-production chores).
import { useId, type CSSProperties, type ReactElement } from 'react';

type Draw = (gradient: string) => ReactElement;

const GLASS: Record<string, Draw> = {
  iris: g => <><path d="M32 9C38 9 42 17 38 24C45 20 53 24 53 31C53 38 45 42 38 38C42 45 38 53 31 53C24 53 20 45 24 38C17 42 9 38 9 31C9 24 17 20 24 24C20 17 24 9 32 9Z" fill={g} /><path d="M32 10C36 10 40 15 39 21L32 30 25 23C22 17 25 10 32 10Z" fill="#FFF" opacity=".72" /><path d="M33 32 48 26C55 34 46 42 39 38L34 49 28 38Z" fill="#9E9ABF" opacity=".38" /><circle cx="31" cy="31" r="6" fill="#26214C" /><circle cx="31" cy="30" r="5" fill="#181333" /></>,
  admission: g => <><path d="M32 6 52 14v15c0 13-9 22-20 29C21 51 12 42 12 29V14Z" fill={g} /><path d="m32 6 20 8-20 12-20-12Z" fill="#FFF" opacity=".7" /><path d="M32 26v32c11-7 20-16 20-29V14Z" fill="#8783AC" opacity=".36" /><path d="m23 31 6 6 13-14" fill="none" stroke="#39345F" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></>,
  agreement: g => <><path d="M14 7h25l12 12v39H14Z" fill={g} /><path d="M39 7v14h12Z" fill="#A19BBF" /><path d="M39 7 51 19H39Z" fill="#FFF" /><path d="M22 29h18M22 36h13" stroke="#777093" strokeWidth="3" strokeLinecap="round" /><path d="m21 48 5-5 2 6 5-5 7 3" stroke="#524B77" strokeWidth="2.8" fill="none" strokeLinecap="round" /></>,
  invoice: g => <><path d="M16 7h32v50l-8-4-8 4-8-4-8 4Z" fill={g} /><path d="M16 7h32l-6 7H22Z" fill="#FFF" opacity=".84" /><path d="m42 14 6-7v50l-6-3Z" fill="#8D88B0" opacity=".55" /><path d="M24 23h15M24 32h15M24 41h10" stroke="#68618B" strokeWidth="3.5" strokeLinecap="round" /></>,
  context: g => <><path d="m9 32 23-13 23 13-23 14Z" fill="#8882B0" /><path d="m9 24 23-13 23 13-23 14Z" fill={g} /><path d="m32 11 23 13-23 14Z" fill="#B9B4D4" /><path d="m9 40 23 14 23-14v7L32 60 9 47Z" fill={g} opacity=".86" /><path d="m9 24 23 14v8L9 32Z" fill="#F7F5FF" opacity=".6" /></>,
  loop: g => <><path d="M16 28a17 17 0 0 1 28-13l-5 6h17V5l-6 5A25 25 0 0 0 8 28Z" fill={g} /><path d="M48 36a17 17 0 0 1-28 13l5-6H8v16l6-5a25 25 0 0 0 42-18Z" fill={g} /><path d="m39 21 17-16v16ZM25 43 8 59V43Z" fill="#A8A2C9" opacity=".7" /></>,
  skill: g => <><path d="m32 3 9 20 20 9-20 9-9 20-9-20L3 32l20-9Z" fill={g} /><path d="m32 3 0 29L3 32l20-9Z" fill="#FFF" opacity=".8" /><path d="m32 32 29 0-20 9-9 20Z" fill="#8B86AD" opacity=".54" /><path d="m32 32 9-9 20 9Z" fill="#F9F6FF" opacity=".7" /></>,
  trace: g => <><path d="M18 15v34M18 32h27V17M18 42h27v9" stroke="#B5AED5" strokeWidth="7" strokeLinecap="round" fill="none" /><path d="M18 15v28M18 29h25V17" stroke="#FFF" strokeWidth="2" opacity=".8" fill="none" /><circle cx="18" cy="13" r="8" fill={g} /><circle cx="45" cy="14" r="8" fill={g} /><circle cx="18" cy="51" r="8" fill={g} /><circle cx="45" cy="51" r="8" fill={g} /></>,
  people: g => <><circle cx="25" cy="21" r="10" fill={g} /><path d="M7 56V45c0-10 8-15 18-15s18 5 18 15v11Z" fill={g} /><circle cx="46" cy="24" r="8" fill="#C3BEDB" /><path d="M43 38c8-3 16 3 16 11v7H47V45Z" fill={g} /><path d="M12 44c1-6 6-9 12-9" fill="none" stroke="#FFF" strokeWidth="2" opacity=".65" /></>,
  inbox: g => <><path d="M15 13h34l10 27v17H5V40Z" fill={g} /><path d="M15 13h34l8 24H40l-4 7h-8l-4-7H7Z" fill="#D2CDE7" /><path d="M5 40h19l4 7h8l4-7h19v17H5Z" fill={g} /><path d="M15 14h34" stroke="#FFF" strokeWidth="2" /></>,
  settings: g => <><path fill={g} fillRule="evenodd" d="m27 5 10 0 2 8 7 4 8-2 5 9-6 6v8l6 6-5 9-8-2-7 4-2 8H27l-2-8-7-4-8 2-5-9 6-6v-8l-6-6 5-9 8 2 7-4Zm5 17a12 12 0 1 0 0 24 12 12 0 0 0 0-24Z" /><path d="m27 5-2 8-7 4-8-2-5 9 6 6" fill="none" stroke="#FFF" strokeWidth="2" opacity=".75" /></>,
};

export interface GlassProps { name: string; size?: number; className?: string; style?: CSSProperties; title?: string }
export function Glass({ name, size = 24, className, style, title }: GlassProps) {
  const id = useId(); const g = `url(#g${id})`; const draw = GLASS[name] ?? GLASS.context!;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} style={{ flexShrink: 0, ...style }} aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <defs><linearGradient id={`g${id}`} x1="10" y1="7" x2="49" y2="60" gradientUnits="userSpaceOnUse"><stop stopColor="#FFFFFF" /><stop offset=".45" stopColor="#E9E6F6" /><stop offset=".72" stopColor="#BDB7D8" /><stop offset="1" stopColor="#716B96" /></linearGradient></defs>
      <g opacity=".2" transform="translate(0 3)">{draw(g)}</g>
      {draw(g)}
    </svg>
  );
}

const STROKE: Record<string, string> = {
  copy: 'M8 7V4h12v13h-3M4 8h12v13H4Z',
  collective: 'M5 5h4v4H5ZM3 17h4v4H3ZM15 3h4v4h-4ZM7 9l-2 8M9 7l6-2M17 13v8M13 17h8',
  more: 'M5 12h.1M12 12h.1M19 12h.1',
  search: 'M21 21l-5-5M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14',
  history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7',
  cloud: 'M6 18h12a4 4 0 0 0 0-8 6 6 0 0 0-11-2 5 5 0 0 0-1 10',
  hide: 'M3 4h18v16H3ZM9 4v16M16 8l-4 4 4 4',
  open: 'M3 4h18v16H3ZM9 4v16M13 8l4 4-4 4',
  plus: 'M12 5v14M5 12h14',
  at: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-4 7.5',
  sparkle: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2Z',
  chevron: 'M6 9l6 6 6-6',
  check: 'M5 12l5 5 9-10',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  pin: 'M9 4h6l-1 6 3 3v2H7v-2l3-3ZM12 15v5',
  rename: 'M4 20h4l10-10-4-4L4 16ZM13 7l4 4',
  archive: 'M4 5h16v4H4ZM5 9v11h14V9M10 13h4',
  device: 'M4 5h16v11H4ZM8 20h8',
  stop: 'M7 7h10v10H7Z',
  external: 'M14 5h5v5M19 5l-8 8M19 13v6H5V5h6',
  expand: 'M4 10V4h6M20 14v6h-6M4 4l7 7M20 20l-7-7',
  download: 'M12 4v11M7 10l5 5 5-5M5 19h14',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  mail: 'M3 6h18v12H3ZM3 7l9 6 9-6',
  key: 'M15 3a6 6 0 1 0 4.5 10L21 14.5V17h-2.5V19.5H16L14.5 21H12v-2.5L14.6 15.9A6 6 0 0 0 15 3Z',
  card: 'M3 6h18v12H3ZM3 10h18',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1',
  shield: 'M12 3l8 3v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6Z',
  layers: 'M12 3l9 5-9 5-9-5ZM3 13l9 5 9-5',
  doc: 'M6 3h9l5 5v13H6ZM14 3v6h6M9 13h6M9 17h6',
  dot: 'M12 12h.1',
};

export interface IconProps { name: string; size?: number; className?: string; style?: CSSProperties; strokeWidth?: number; title?: string }
export function Icon({ name, size = 18, className, style, strokeWidth = 1.5, title }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={{ flexShrink: 0, ...style }} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={STROKE[name] ?? STROKE.dot!} />
    </svg>
  );
}

export const KIND_ICON: Record<string, string> = { application: 'admission', invoice: 'invoice', agreement: 'agreement' };
