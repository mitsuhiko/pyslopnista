// Find in folder: search the text files of a folder (and its subfolders),
// results grouped by file; tap one to open it at that line. ⌘⇧F.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { base64ToBytes, basename, displayName, fs, join } from "./host";
import { Search } from "./Icons";

const TEXT_FILE = /\.(py|pyi|txt|md|json|toml|csv|tsv|html?|css|js|ts|ya?ml|cfg|ini|xml|svg|sql|sh|rst)$/i;
const MAX_FILE_BYTES = 1_000_000;
const MAX_RESULTS = 500;

interface Hit {
  path: string;
  line: number;
  column: number;
  text: string;
  length: number;
}

interface Props {
  dir: string;
  /** Saves pending edits first, so the search sees them. */
  beforeSearch: () => Promise<void>;
  onOpen: (path: string, line: number, column: number) => void;
  onClose: () => void;
}

export function FindPanel({ dir, beforeSearch, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<{ path: string; text: string }[] | null>(null);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    let live = true;
    void (async () => {
      await beforeSearch();
      const tree = await fs.tree(dir);
      const decoder = new TextDecoder();
      const loaded = tree
        .filter((f) => TEXT_FILE.test(f.path) && !f.path.split("/").some((part) => part.startsWith(".") || part === "__pycache__"))
        .map((f) => ({ path: join(dir, f.path), bytes: base64ToBytes(f.data) }))
        .filter((f) => f.bytes.length <= MAX_FILE_BYTES)
        .map((f) => ({ path: f.path, text: decoder.decode(f.bytes) }))
        .sort((a, b) => a.path.localeCompare(b.path));
      if (live) setFiles(loaded);
    })().catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [dir]);

  const hits = useMemo(() => {
    const out: Hit[] = [];
    if (!files || query.length < 1) return out;
    const needle = caseSensitive ? query : query.toLowerCase();
    for (const f of files) {
      const lines = f.text.split("\n");
      for (let i = 0; i < lines.length && out.length < MAX_RESULTS; i++) {
        const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
        let at = hay.indexOf(needle);
        while (at >= 0 && out.length < MAX_RESULTS) {
          out.push({ path: f.path, line: i + 1, column: at + 1, text: lines[i], length: query.length });
          at = hay.indexOf(needle, at + Math.max(1, needle.length));
        }
      }
    }
    return out;
  }, [files, query, caseSensitive]);

  const groups = useMemo(() => {
    const map = new Map<string, Hit[]>();
    for (const h of hits) map.set(h.path, [...(map.get(h.path) ?? []), h]);
    return [...map];
  }, [hits]);

  const preview = (h: Hit) => {
    // Trim long lines around the match, keep the indentation readable.
    const start = Math.max(0, h.column - 1 - 40);
    const before = (start > 0 ? "…" : "") + h.text.slice(start, h.column - 1).trimStart();
    const match = h.text.slice(h.column - 1, h.column - 1 + h.length);
    const after = h.text.slice(h.column - 1 + h.length, h.column - 1 + h.length + 80);
    return (
      <>
        {before}
        <mark>{match}</mark>
        {after}
      </>
    );
  };

  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-sheet find-sheet" role="dialog" aria-label="Find in folder">
        <div className="modal-header">
          <div className="grabber" />
          <div className="modal-title-row">
            <span className="modal-title">Find in {dir ? displayName(dir) : "Files"}</span>
            <button className="text-button" onClick={onClose}>Done</button>
          </div>
          <div className="find-row">
            <div className="search-field find-field">
              <Search size={17} />
              <input
                ref={input}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && onClose()}
                placeholder="Search"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="search"
                aria-label="Search text"
              />
            </div>
            <button className={`case-toggle ${caseSensitive ? "active" : ""}`} onClick={() => setCaseSensitive((c) => !c)} aria-pressed={caseSensitive} title="Match case">
              Aa
            </button>
          </div>
          {query && files && (
            <div className="find-summary">
              {hits.length === 0 ? "No results" : `${hits.length >= MAX_RESULTS ? `${MAX_RESULTS}+` : hits.length} result${hits.length === 1 ? "" : "s"} in ${groups.length} file${groups.length === 1 ? "" : "s"}`}
            </div>
          )}
        </div>
        <div className="modal-body">
          {!files && <div className="find-loading"><span className="spinner" /></div>}
          {groups.map(([path, list]) => (
            <section className="find-group" key={path}>
              <div className="find-file">
                {basename(path)}
                <span className="find-file-dir">{path.slice(dir ? dir.length + 1 : 0, -basename(path).length)}</span>
              </div>
              <div className="grouped-list">
                {list.map((h, i) => (
                  <button
                    key={i}
                    className="find-hit"
                    onClick={() => {
                      onClose();
                      onOpen(h.path, h.line, h.column);
                    }}
                  >
                    <span className="find-line">{h.line}</span>
                    <span className="find-text">{preview(h)}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
