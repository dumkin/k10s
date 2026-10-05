import type { JSX } from "solid-js";

// 24×24 stroke icons (inner SVG markup). Static strings → zero runtime cost, tree-shaken by name use.
const ICONS = {
  pod: '<path d="m21 7.5-9-5-9 5 9 5z"/><path d="M3 7.5v9l9 5 9-5v-9"/><path d="M12 12.5v9"/>',
  deployment: '<path d="m12 2.5 9 4.8-9 4.8-9-4.8z"/><path d="m3 12 9 4.8 9-4.8"/><path d="m3 16.7 9 4.8 9-4.8"/>',
  statefulset: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  replicaset: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  daemonset: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
  job: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.2 3.5-5.2 3.5z"/>',
  cronjob: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  service: '<rect x="9" y="2.5" width="6" height="6" rx="1.2"/><rect x="2.5" y="15.5" width="6" height="6" rx="1.2"/><rect x="15.5" y="15.5" width="6" height="6" rx="1.2"/><path d="M12 8.5v3.5M5.5 15.5v-1.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1.5"/>',
  ingress: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  endpoint: '<path d="M9 2.5v5M15 2.5v5M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5v5"/>',
  shield: '<path d="M12 3 20 6v6c0 4.9-3.4 8-8 9-4.6-1-8-4.1-8-9V6z"/>',
  config: '<path d="M14 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  secret: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.8-8.8M16 7l2.5 2.5M19 4l2 2"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
  volume: '<rect x="2.5" y="13" width="19" height="8" rx="2"/><path d="M5.7 3.5h12.6L21.5 13h-19z"/><path d="M6.5 17h.01M10 17h.01"/>',
  node: '<rect x="3" y="3" width="18" height="7.5" rx="2"/><rect x="3" y="13.5" width="18" height="7.5" rx="2"/><path d="M7 6.75h.01M7 17.25h.01"/>',
  namespace: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  event: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20.5a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 13.7a6.5 6.5 0 0 1 3.5 6.8"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  crd: '<rect x="3" y="3" width="8" height="8" rx="1.6"/><rect x="13" y="13" width="8" height="8" rx="1.6"/><path d="M17 3v8M13 7h8M3 17h8M7 13v8"/>',
  webhook: '<path d="M10 13.5a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 10.5a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  flag: '<path d="M5 21.5V3.5"/><path d="M5 4h12l-2.5 4.5L17 13H5"/>',
  pie: '<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15.5 3.7A9 9 0 0 1 20.3 8.5H15.5z"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>',
  ruler: '<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  storage: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  overview: '<rect x="3" y="3" width="7.5" height="9" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="5" rx="1.6"/><rect x="13.5" y="11" width="7.5" height="10" rx="1.6"/><rect x="3" y="15" width="7.5" height="6" rx="1.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12.5 4.5 4.5L19.5 7"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  "chevron-up": '<path d="m6 15 6-6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.5A2 2 0 0 0 8.5 21h7a2 2 0 0 0 2-1.5l1-12.5M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 0 1-15.1 5.3M3.5 12A8.5 8.5 0 0 1 18.6 6.7"/><path d="M19 2.5v4.5h-4.5M5 21.5V17h4.5"/>',
  restart: '<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3"/><path d="M3.5 3.5v5h5"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M12.5 15h4.5"/>',
  logs: '<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>',
  list: '<path d="M8.5 6H21M8.5 12H21M8.5 18H21M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  copy: '<rect x="8.5" y="8.5" width="12.5" height="12.5" rx="2"/><path d="M15.5 8.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  layers: '<path d="m12 2.5 9 4.8-9 4.8-9-4.8z"/><path d="m3 12 9 4.8 9-4.8"/>',
  star: '<path d="m12 3 2.8 5.6 6.2.9-4.5 4.4 1.1 6.1L12 17.1 6.4 20l1.1-6.1L3 9.5l6.2-.9z"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  "arrow-down": '<path d="M12 4v16M5.5 13.5 12 20l6.5-6.5"/>',
  "arrow-up": '<path d="M12 20V4M5.5 10.5 12 4l6.5 6.5"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  wrap: '<path d="M3 6h18M3 12h14.5a3.5 3.5 0 0 1 0 7H13M3 18h6"/><path d="m15 16.5-2.5 2.5 2.5 2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.4 3.4M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6M3 3l18 18"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  filter: '<path d="M3 4.5h18l-7 8.5v6.5l-4-2V13z"/>',
  alert: '<path d="M10.3 3.9 1.8 18.5A2 2 0 0 0 3.5 21.5h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17.5h.01"/>',
  "alert-circle": '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>',
  power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2.5v9"/>',
  sidebar: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><path d="M9 3.5v17"/>',
  columns: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><path d="M9 3.5v17M15 3.5v17"/>',
  scale: '<path d="M8 3.5 4 7.5l4 4M4 7.5h16M16 12.5l4 4-4 4M20 16.5H4"/>',
  zap: '<path d="M13 2.5 4 14h7.5L10.5 21.5 20 10h-7.5z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  external: '<path d="M14 3.5h6.5V10M20.5 3.5 11 13M18 14v4.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2H10"/>',
  maximize: '<path d="M14.5 3.5h6v6M9.5 20.5h-6v-6M20.5 3.5l-7 7M3.5 20.5l7-7"/>',
  minimize: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  keyboard: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M6.5 12.5h.01M17 12.5h.01M8.5 15.5h7"/>',
  link: '<path d="M10 13.5a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 10.5a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  relations: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M10.8 7.3 6.2 16.7M13.2 7.3l4.6 9.4M7.5 19h9"/>',
  patterns: '<rect x="3" y="4" width="18" height="4.5" rx="1.5"/><rect x="3" y="10.75" width="12" height="4.5" rx="1.5"/><rect x="3" y="17.5" width="7" height="4.5" rx="1.5"/>',
  braces: '<path d="M8 3.5H7a2 2 0 0 0-2 2v4a2.5 2.5 0 0 1-2 2.5 2.5 2.5 0 0 1 2 2.5v4a2 2 0 0 0 2 2h1M16 3.5h1a2 2 0 0 1 2 2v4a2.5 2.5 0 0 0 2 2.5 2.5 2.5 0 0 0-2 2.5v4a2 2 0 0 1-2 2h-1"/>',
  download: '<path d="M12 3.5v12M6.5 10.5 12 16l5.5-5.5M4 20.5h16"/>',
  bars: '<path d="M4 20.5h16M7 17V12M11 17V6M15 17v-7M19 17v-3"/>',
  dock: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><path d="M3 14.5h18"/>',
  compare: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5V15a3 3 0 0 0 3 3h4"/><path d="m11 15.5 2.5 2.5-2.5 2.5"/><path d="M18 15.5V9a3 3 0 0 0-3-3h-4"/><path d="m13 3.5-2.5 2.5 2.5 2.5"/>',
  pin: '<path d="M9 3.5h6l-1 5.5 3.5 3.5v2.5h-11v-2.5L10 9z"/><path d="M12 15v6"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon(props: { name: IconName; size?: number; class?: string; style?: JSX.CSSProperties; strokeWidth?: number }) {
  return (
    <svg
      class={`icon ${props.class ?? ""}`}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? 1.8}
      stroke-linecap="round"
      stroke-linejoin="round"
      style={props.style}
      aria-hidden="true"
      innerHTML={ICONS[props.name]}
    />
  );
}
