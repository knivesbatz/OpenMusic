// Original line icons (24px grid). currentColor so they follow text/active colors.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function make(path: JSX.Element, fill = false) {
  return ({ size = 20, ...rest }: P) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {path}
    </svg>
  );
}

export const IHome = make(<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" />);
export const ISearch = make(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const ILibrary = make(<><path d="M4 3v18M9 3v18" /><path d="m14 3.5 6 17" /></>);
export const IPlus = make(<path d="M12 5v14M5 12h14" />);
export const IPlay = make(<path d="M7 4.5v15a.5.5 0 0 0 .77.42l11.5-7.5a.5.5 0 0 0 0-.84L7.77 4.08A.5.5 0 0 0 7 4.5z" />, true);
export const IPause = make(<><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>, true);
export const INext = make(<><path d="M5 4.5v15l11-7.5z" /><rect x="17" y="4" width="2.5" height="16" rx="1" /></>, true);
export const IPrev = make(<><path d="M19 4.5v15L8 12z" /><rect x="4.5" y="4" width="2.5" height="16" rx="1" /></>, true);
export const IShuffle = make(<><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></>);
export const IRepeat = make(<><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>);
export const IQueue = make(<><path d="M3 6h13M3 12h13M3 18h9" /><path d="m17 15 4 3-4 3z" /></>);
export const ILyrics = make(<><path d="M4 5h16v11H8l-4 4z" /><path d="M8 9h8M8 12h5" /></>);
export const IVolume = make(<><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /></>);
export const IMute = make(<><path d="M4 9v6h4l5 4V5L8 9z" /><path d="m17 9 5 6M22 9l-5 6" /></>);
export const IFullscreen = make(<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />);
export const IExitFullscreen = make(<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />);
export const IPip = make(<><rect x="2" y="4" width="20" height="16" rx="2" /><rect x="12" y="12" width="7" height="5" rx="1" /></>);
export const IHeart = make(<path d="M12 20s-7-4.5-9.3-9A5 5 0 0 1 12 6a5 5 0 0 1 9.3 5C19 15.5 12 20 12 20z" />);
export const IHeartFill = make(<path d="M12 20s-7-4.5-9.3-9A5 5 0 0 1 12 6a5 5 0 0 1 9.3 5C19 15.5 12 20 12 20z" />, true);
export const ICheck = make(<path d="m5 12 5 5 9-10" />);
export const IAddCircle = make(<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>);
export const IChecked = make(<><circle cx="12" cy="12" r="10" fill="#1DB954" stroke="none" /><path d="m7.5 12 3 3 6-6" stroke="#000" /></>);
export const IMore = make(<><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>, true);
export const IBack = make(<path d="m15 18-6-6 6-6" />);
export const IForward = make(<path d="m9 18 6-6-6-6" />);
export const IClose = make(<path d="M6 6l12 12M18 6 6 18" />);
export const ISettings = make(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
export const IDownload = make(<><circle cx="12" cy="12" r="9" /><path d="M12 7v9M8 12l4 4 4-4" /></>);
export const IMusic = make(<><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>);
export const IFolderOpen = make(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H7.5a2 2 0 0 0-1.9 1.4L3 19z M3 19l2.6-7.6A2 2 0 0 1 7.5 10H21l-2.6 7.6A2 2 0 0 1 16.5 19z" />);
export const IFolder = make(<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
export const IDrag = make(<path d="M5 9h14M5 15h14" />);
export const IClock = make(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IMic = make(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>);
export const IImport = make(<><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 17v3h16v-3" /></>);
export const IGrip = make(<><circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /></>, true);
