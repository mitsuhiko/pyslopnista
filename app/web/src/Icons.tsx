// SF Symbols-style icons as inline SVG (24x24 grid, currentColor).
import type { ReactNode } from "react";

type IconProps = { size?: number; className?: string };

const stroke = (children: ReactNode, sw = 1.9) =>
  function Icon({ size = 22, className }: IconProps) {
    return (
      <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    );
  };

const fill = (children: ReactNode) =>
  function Icon({ size = 22, className }: IconProps) {
    return (
      <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        {children}
      </svg>
    );
  };

export const ChevronLeft = stroke(<path d="M15 4.5 7.5 12l7.5 7.5" />, 2.4);
export const ChevronRight = stroke(<path d="m9 4.5 7.5 7.5L9 19.5" />, 2.2);
export const ChevronDown = stroke(<path d="m5 9 7 7 7-7" />, 2.2);
export const ChevronUp = stroke(<path d="m5 15 7-7 7 7" />, 2.2);
export const Ellipsis = fill(<><circle cx="5.5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="18.5" cy="12" r="1.9" /></>);
export const Plus = stroke(<path d="M12 4.5v15M4.5 12h15" />, 2.2);
export const Play = fill(<path d="M7.5 4.6v14.8a1 1 0 0 0 1.5.86l12.2-7.4a1 1 0 0 0 0-1.72L9 3.74A1 1 0 0 0 7.5 4.6z" />);
export const Stop = fill(<rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />);
export const Trash = stroke(<><path d="M4 6.5h16M9.5 6.5V4.5h5v2M6 6.5l1 13a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4l1-13" /><path d="M10 10.5v6.5M14 10.5v6.5" /></>);
export const Pencil = stroke(<><path d="M15.5 4.5l4 4L8.5 19.5 4 20l.5-4.5z" /><path d="M13.5 6.5l4 4" /></>);
export const Duplicate = stroke(<><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>);
export const Search = stroke(<><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>, 2.1);
export const Wand = stroke(<><path d="m4 20 11-11" /><path d="m13 7 2-2 4 4-2 2z" fill="currentColor" stroke="none" /><path d="M18 3.5v2M17 4.5h2M20.5 9v1.6M19.7 9.8h1.6M8.5 3v1.6M7.7 3.8h1.6" /></>, 1.7);
export const Warning = stroke(<><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.2" r=".4" fill="currentColor" /></>);
export const Terminal = stroke(<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4" /></>);
export const Close = stroke(<path d="M6 6l12 12M18 6 6 18" />, 2.2);
export const KeyboardDown = stroke(<><rect x="3" y="3.5" width="18" height="12" rx="2" /><path d="M6.5 7h1M10 7h1M13.5 7h1M17 7h.5M6.5 10.2h1M10 10.2h4M17 10.2h.5M8 12.8h8M9.5 18.5l2.5 2 2.5-2" /></>, 1.6);
export const Undo = stroke(<><path d="M9 14 4.5 9.5 9 5" /><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-2" /></>);
export const Redo = stroke(<><path d="m15 14 4.5-4.5L15 5" /><path d="M19.5 9.5H10a5.5 5.5 0 0 0 0 11h2" /></>);
export const Comment = stroke(<path d="M8 19 12 5M13 19l4-14" />, 2);
export const Indent = stroke(<><path d="M4 5h16M11 10h9M11 14.5h9M4 19h16" /><path d="m4 9.5 3 2.5-3 2.5" /></>);
export const Outdent = stroke(<><path d="M4 5h16M11 10h9M11 14.5h9M4 19h16" /><path d="m7 9.5-3 2.5 3 2.5" /></>);
export const Folder = fill(<path d="M2.5 6.5A2.5 2.5 0 0 1 5 4h4.3a2 2 0 0 1 1.5.65L12.4 6.5H19a2.5 2.5 0 0 1 2.5 2.5v8.5A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5z" />);
export const FolderPlus = stroke(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10.5v5M9.5 13h5" /></>);
export const DocPlus = stroke(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 11v6M9 14h6" /></>);
export const Checkmark = stroke(<path d="m5 12.5 4.5 4.5L19 7.5" />, 2.4);
export const Clock = stroke(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const Error = fill(<path d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zm0 5a1.1 1.1 0 0 1 1.1 1.1v4.2a1.1 1.1 0 1 1-2.2 0V8.6A1.1 1.1 0 0 1 12 7.5zm0 10.2a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6z" />);
export const CheckCircle = fill(<path d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zm4.6 7.1-5.3 5.9a1 1 0 0 1-1.46.04l-2.7-2.7a1 1 0 1 1 1.42-1.42l1.95 1.96 4.6-5.12a1 1 0 0 1 1.49 1.34z" />);
export const StopCircle = fill(<path d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zM9 8h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />);
export const Sidebar = stroke(<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M9.5 4.5v15M5.5 8h2M5.5 11h2" /></>);
export const Sort = stroke(<path d="M7 4.5v15M4 16.5l3 3 3-3M17 19.5v-15M14 7.5l3-3 3 3" />);

export const Gear = stroke(<><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /><circle cx="12" cy="12" r="6.3" /></>, 1.8);
export const ListBullet = stroke(<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />, 2.2);
export const Info = stroke(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.6v.1" /></>, 2);
export const Lock = fill(<path d="M7.5 10V7.5a4.5 4.5 0 0 1 9 0V10h.5A2 2 0 0 1 19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zm2 0h5V7.5a2.5 2.5 0 0 0-5 0z" />);
export const SplitView = stroke(<><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M12 4.5v15" /></>);
export const JumpTo = stroke(<><path d="M4 12h12M12 7l5 5-5 5" /><path d="M20 5v14" /></>, 2);
export const Back = stroke(<path d="M15 4.5 7.5 12l7.5 7.5" />, 2.2);

// Debugger
export const PauseCircle = fill(<path d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zM9.6 8h.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-.8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zm4 0h.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-.8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />);
export const Pause = fill(<><rect x="6" y="5" width="4.2" height="14" rx="1.3" /><rect x="13.8" y="5" width="4.2" height="14" rx="1.3" /></>);
export const Continue = fill(<><rect x="4" y="5" width="3" height="14" rx="1.2" /><path d="M10 5.9v12.2a1 1 0 0 0 1.52.85l9.6-6.1a1 1 0 0 0 0-1.7l-9.6-6.1A1 1 0 0 0 10 5.9z" /></>);
export const StepOver = stroke(<><path d="M4.5 14a7.5 7.5 0 0 1 14.2-3.4" /><path d="m19.5 5.5-.6 5.3-5.2-.9" /><circle cx="12" cy="18.5" r="1.6" fill="currentColor" stroke="none" /></>, 2);
export const StepInto = stroke(<><path d="M12 3.5v10" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" /><circle cx="12" cy="19.5" r="1.6" fill="currentColor" stroke="none" /></>, 2);
export const StepOut = stroke(<><path d="M12 14.5v-10" /><path d="m7.5 8.5 4.5-4.5 4.5 4.5" /><circle cx="12" cy="19.5" r="1.6" fill="currentColor" stroke="none" /></>, 2);
export const Inspect = stroke(<><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5M10.5 7.5v3.2M10.5 13.2v.1" /></>, 2);

/** File type icon in the style of the Files app. */
export function FileIcon({ name, size = 30 }: { name: string; size?: number }) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const palette: Record<string, [string, string]> = {
    py: ["#3776ab", "#ffd43b"],
    txt: ["#8e8e93", "#c7c7cc"],
    md: ["#5856d6", "#a5a3f5"],
    json: ["#ff9500", "#ffcc80"],
    csv: ["#34c759", "#a8e6b5"],
    toml: ["#af52de", "#d9a8f0"],
  };
  const [ink, accent] = palette[ext] ?? ["#8e8e93", "#c7c7cc"];
  return (
    <svg width={size * 0.8} height={size} viewBox="0 0 24 30" aria-hidden="true">
      <path d="M3 1.5h12.5L22.5 8.5v18.5a2 2 0 0 1-2 2H3.5a2 2 0 0 1-2-2V3.5a2 2 0 0 1 2-2z" fill="var(--file-bg)" stroke="var(--file-stroke)" strokeWidth="1" />
      <path d="M15.5 1.5v5a2 2 0 0 0 2 2h5" fill="none" stroke="var(--file-stroke)" strokeWidth="1" />
      {ext === "py" ? (
        <g transform="translate(5.2 11.5) scale(0.6)">
          <path d="M11.9 1c-5.6 0-5.3 2.4-5.3 2.4v2.5h5.4v.8H4.5S1 6.3 1 11.8s3.1 5.3 3.1 5.3H6v-2.6s-.1-3.1 3-3.1h5.3s2.9 0 2.9-2.8V4.1S17.6 1 11.9 1zM9 2.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" fill={ink} />
          <path d="M12.1 23c5.6 0 5.3-2.4 5.3-2.4v-2.5H12v-.8h7.5s3.5.4 3.5-5.1-3.1-5.3-3.1-5.3H18v2.6s.1 3.1-3 3.1H9.7s-2.9 0-2.9 2.8v4.5S6.4 23 12.1 23zm2.9-1.6a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" fill={accent} />
        </g>
      ) : (
        <text x="12" y="22" textAnchor="middle" fontSize="6.2" fontWeight="700" fontFamily="-apple-system, system-ui" fill={ink}>
          {(ext || "file").slice(0, 4).toUpperCase()}
        </text>
      )}
    </svg>
  );
}

export function FolderIcon({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.82} viewBox="0 0 30 25" aria-hidden="true">
      <path d="M1.5 4A2.5 2.5 0 0 1 4 1.5h7.1a2 2 0 0 1 1.5.7l1.9 2.3H26A2.5 2.5 0 0 1 28.5 7v14.5A2.5 2.5 0 0 1 26 24H4a2.5 2.5 0 0 1-2.5-2.5z" fill="#2f9bf5" />
      <path d="M1.5 8.5h27v13A2.5 2.5 0 0 1 26 24H4a2.5 2.5 0 0 1-2.5-2.5z" fill="#5ab3fa" />
    </svg>
  );
}
