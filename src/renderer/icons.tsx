import type { ReactNode } from 'react';

const shapes = {
  logo: <><path d="M3.6 16.4 9 5.2h4.2L7.8 16.4H3.6Z"/><path d="m12.3 16.4 5.4-11.2h2.7L15 16.4h-2.7Z"/><path d="M2.8 19h13.6"/></>,
  files: <><path d="M8 4h7l4 4v12H8z"/><path d="M15 4v5h4M5 17H3V7h2"/></>,
  file: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6m-6 4h6"/></>,
  code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  filePlus: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4m-6 3v7m-3.5-3.5h7"/></>,
  folder: <path d="M3 6h7l2 2h9v11H3z"/>,
  folderPlus: <><path d="M3 6h7l2 2h9v11H3z"/><path d="M12 10.5v6m-3-3h6"/></>,
  open: <path d="M3 18V6h7l2 2h8v3m-17 7 4-7h15l-4 7H3z"/>,
  home: <path d="m3 10 9-7 9 7M5 9v11h14V9m-9 11v-6h4v6"/>,
  terminal: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></>,
  settings: <><path d="m10 3-.7 2.6-2 .9-2.4-1.2-2 3.5L5 10.7v2.6l-2.1 1.9 2 3.5 2.4-1.2 2 .9.7 2.6h4l.7-2.6 2-.9 2.4 1.2 2-3.5-2.1-1.9v-2.6l2.1-1.9-2-3.5-2.4 1.2-2-.9L14 3h-4Z"/><circle cx="12" cy="12" r="2.7"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 8a7.5 7.5 0 0 1 12.3-2.3L20 8M4 16l2.1 2.3A7.5 7.5 0 0 0 18.4 16"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  down: <path d="m5 9 7 7 7-7"/>,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6"/>,
  diagonal: <path d="M6 18 18 6M8 6h10v10"/>,
  x: <path d="m6 6 12 12M18 6 6 18"/>,
  play: <path d="m8 5 11 7-11 7V5Z" fill="currentColor" strokeLinejoin="round"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>,
  explorer: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14"/></>,
  panel: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 14h18"/></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
  columns: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/></>,
  search: <><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/></>,
  replace: <><path d="M3 8h13m-3-3 3 3-3 3m8 5H8m3-3-3 3 3 3"/><path d="M3 16h1m16-8h1"/></>,
  format: <path d="M4 5h16M9 10h11M9 15h11M4 20h16M4 10v5"/>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  book: <><path d="M12 6c-2.4-2.4-5.3-2.6-9-2v14c3.7-.6 6.6-.4 9 2 2.4-2.4 5.3-2.6 9-2V4c-3.7-.6-6.6-.4-9 2v14Z"/><path d="M6 8h2m-2 4h2m8-4h2m-2 4h2"/></>,
  marketplace: <><path d="M4 10v10h16V10M3 10l2-6h14l2 6M3 10c0 2.2 4.5 2.2 4.5 0 0 2.2 4.5 2.2 4.5 0 0 2.2 4.5 2.2 4.5 0 0 2.2 4.5 2.2 4.5 0M9 20v-5h6v5"/></>,
  map: <><rect x="3" y="4" width="5" height="5" rx="1"/><rect x="16" y="15" width="5" height="5" rx="1"/><path d="M5.5 9v6a2.5 2.5 0 0 0 2.5 2.5h8m-4-13h8m-4-2v4"/></>,
  flask: <><path d="M9 3h6m-5 0v6l-5 8a2.5 2.5 0 0 0 2.1 4h9.8a2.5 2.5 0 0 0 2.1-4l-5-8V3M8 15h8"/></>,
  bolt: <path d="m13 2-8 12h6l-1 8 9-13h-6l1-7z"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  save: <><path d="M4 4h13l3 3v13H4zM8 4v5h8V4m-8 16v-7h8v7"/></>,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1m2.5 0h1m3 0h1m2.5 0h1M6 14h1m2.5 0h5m2.5 0h1"/></>,
  edit: <><path d="m14 5 5 5M4 20l5-1 12-12-5-5L4 14v6z"/></>,
  trash: <path d="M4 6h16M9 6V3h6v3m3 0-1 14H7L6 6m4 4v6m4-6v6"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8v.1"/></>,
  check: <path d="m4 12 5 5L20 6"/>,
  sliders: <><path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-7 0v6"/></>,
  warning: <><path d="M12 3 2.5 20h19L12 3zM12 9v5m0 2.5v.1"/></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof shapes;
export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {shapes[name]}
    </svg>
  );
}
