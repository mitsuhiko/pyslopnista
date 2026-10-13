// Small SF Symbols-style icons (inline SVG, inherit currentColor).
const svg = (path: React.ReactNode, size = 22) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

export const FolderIcon = () => (
  <svg width="26" height="22" viewBox="0 0 26 22" aria-hidden="true">
    <path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h5.2l2.3 2.5h9.5A2.5 2.5 0 0 1 24 7v10.5a2.5 2.5 0 0 1-2.5 2.5h-17A2.5 2.5 0 0 1 2 17.5z" fill="#5ac8fa" />
    <path d="M2 8h22v9.5a2.5 2.5 0 0 1-2.5 2.5h-17A2.5 2.5 0 0 1 2 17.5z" fill="#34aadc" />
  </svg>
);

export const FileIcon = ({ ext }: { ext: string }) => (
  <svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true">
    <path d="M3 1.5h10l6 6v16a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 2 23.5V3A1.5 1.5 0 0 1 3.5 1.5z" fill="var(--cell-bg)" stroke="var(--tertiary)" />
    <path d="M13 1.5v6h6" fill="none" stroke="var(--tertiary)" />
    <text x="11" y="20" textAnchor="middle" fontSize="6.5" fontWeight="700" fontFamily="-apple-system, system-ui" fill={ext === "py" ? "#3776ab" : "var(--secondary)"}>
      {ext.slice(0, 4).toUpperCase()}
    </text>
  </svg>
);

export const NewFileIcon = () => svg(<><path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" /><path d="M14 3v5h5M12 11v6M9 14h6" /></>);
export const NewFolderIcon = () => svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10.5v5M9.5 13h5" /></>);
export const MoreIcon = () => svg(<><circle cx="6" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="18" cy="12" r="1.2" fill="currentColor" /></>);
export const PlayIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor" /></svg>
);
export const StopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
);
