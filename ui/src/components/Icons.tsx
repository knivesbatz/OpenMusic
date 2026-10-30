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
      strokeWidth={2.3}
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
// Skip: a chunky triangle (the outline rounds its corners) and a thick bar, as in Spotify.
export const INext = make(<><path d="M5.5 5.2v13.6a.8.8 0 0 0 1.25.66l9.6-6.8a.8.8 0 0 0 0-1.32l-9.6-6.8a.8.8 0 0 0-1.25.66z" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" /><rect x="16.6" y="4" width="3.4" height="16" rx="1.4" /></>, true);
export const IPrev = make(<><path d="M18.5 5.2v13.6a.8.8 0 0 1-1.25.66l-9.6-6.8a.8.8 0 0 1 0-1.32l9.6-6.8a.8.8 0 0 1 1.25.66z" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" /><rect x="4" y="4" width="3.4" height="16" rx="1.4" /></>, true);
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
export const IEdit = make(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>);
export const IBookmark = make(<path d="M6 3h12v18l-6-4.5L6 21z" />, true);
export const IChevronDown = make(<path d="m6 9 6 6 6-6" />);
export const IShare = make(<><path d="M12 15V3M7 8l5-5 5 5" /><path d="M5 12v8h14v-8" /></>);
export const IHandle = make(<path d="M4 8h16M4 12h16M4 16h16" />);
export const IDrag = make(<path d="M5 9h14M5 15h14" />);
export const IDisc = make(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /></>);
export const IMoon = make(<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />);
export const IBell = make(<><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>);
export const IClock = make(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
/** A clock turning back: listening history. */
export const IHistory = make(<><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3 3v5h5" /><path d="M12 8v4l3 2" /></>);
export const IMic = make(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>);
export const IImport = make(<><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 17v3h16v-3" /></>);
export const IGrip = make(<><circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /></>, true);
// Menu icons.
export const IQueueAdd = make(<><path d="M3 6h12M3 12h12M3 18h7" /><path d="M18 14v8M14 18h8" /></>);
export const IPlayNext = make(<><path d="M3 6h10M3 12h7M3 18h7" /><path d="M14 11v9l7-4.5z" /></>);
export const IRadio = make(<><circle cx="12" cy="12" r="2" /><path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 19a10 10 0 0 1 0-14M19 5a10 10 0 0 1 0 14" /></>);
export const IUser = make(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const IInfo = make(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>);
export const ITrash = make(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>);
export const IMinusCircle = make(<><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>);
export const IEyeOff = make(<><path d="M3 3l18 18" /><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 5 9 7a9 9 0 0 1-2.4 3.5M6.6 6.6C4.4 8 3 10.4 3 12c0 2 4 7 9 7a9.3 9.3 0 0 0 4.4-1.1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>);
export const IImage = make(<><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></>);
export const ICopy = make(<><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>);
export const ILink = make(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>);
export const IFile = make(<><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4M9 13h6M9 17h6" /></>);
export const IOpen = make(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v6H4V6h6" /></>);
export const IUndo = make(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>);
