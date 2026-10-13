// File browser over the app's Documents folder (also visible in the Files app).
import { useCallback, useEffect, useState } from "react";
import { basename, dirname, type Entry, fs, join } from "./host";
import { FileIcon, FolderIcon, MoreIcon, NewFileIcon, NewFolderIcon } from "./Icons";

interface Props {
  dir: string;
  currentFile: string | null;
  refreshKey: number;
  onOpenDir: (dir: string) => void;
  onOpenFile: (path: string) => void;
  onRenamed: (from: string, to: string) => void;
  onDeleted: (path: string) => void;
}

const iconFor = (e: Entry) => (e.dir ? <FolderIcon /> : <FileIcon ext={e.name.includes(".") ? e.name.split(".").pop()!.toLowerCase() : ""} />);

const validName = (name: string | null): name is string => !!name && !name.includes("/") && name !== "." && name !== "..";

export function FileBrowser({ dir, currentFile, refreshKey, onOpenDir, onOpenFile, onRenamed, onDeleted }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await fs.list(dir));
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [dir]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const newFile = async () => {
    const name = prompt("New file name", "untitled.py");
    if (!validName(name)) return;
    const path = join(dir, name.includes(".") ? name : `${name}.py`);
    if (await fs.exists(path)) return alert(`${basename(path)} already exists.`);
    await fs.writeText(path, "");
    await load();
    onOpenFile(path);
  };

  const newFolder = async () => {
    const name = prompt("New folder name", "Project");
    if (!validName(name)) return;
    await fs.mkdir(join(dir, name));
    await load();
  };

  const rename = async (entry: Entry) => {
    setMenu(null);
    const name = prompt(`Rename ${entry.name}`, entry.name);
    if (!validName(name) || name === entry.name) return;
    const to = join(dirname(entry.path), name);
    if (await fs.exists(to)) return alert(`${name} already exists.`);
    await fs.rename(entry.path, to);
    onRenamed(entry.path, to);
    await load();
  };

  const duplicate = async (entry: Entry) => {
    setMenu(null);
    if (entry.dir) return;
    const dot = entry.name.lastIndexOf(".");
    const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
    const ext = dot > 0 ? entry.name.slice(dot) : "";
    let n = 2;
    while (await fs.exists(join(dir, `${stem} ${n}${ext}`))) n++;
    await fs.writeText(join(dir, `${stem} ${n}${ext}`), await fs.readText(entry.path));
    await load();
  };

  const remove = async (entry: Entry) => {
    setMenu(null);
    if (!confirm(`Delete ${entry.name}${entry.dir ? " and everything in it" : ""}?`)) return;
    await fs.remove(entry.path);
    onDeleted(entry.path);
    await load();
  };

  return (
    <div className="browser">
      <div className="browser-header">
        {dir ? (
          <button className="nav-button" onClick={() => onOpenDir(dirname(dir))}>‹ {dirname(dir) ? basename(dirname(dir)) : "Files"}</button>
        ) : (
          <span />
        )}
        <div className="browser-actions">
          <button className="nav-button icon" onClick={newFolder} aria-label="New folder"><NewFolderIcon /></button>
          <button className="nav-button icon" onClick={newFile} aria-label="New file"><NewFileIcon /></button>
        </div>
      </div>
      <h1 className="large-title">{dir ? basename(dir) : "Files"}</h1>
      {error && <div className="browser-error">{error}</div>}
      <div className="list">
        {entries.length === 0 && !error && <div className="list-empty">Empty folder</div>}
        {entries.map((e) => (
          <div key={e.path} className={`list-row ${e.path === currentFile ? "selected" : ""}`}>
            <button className="list-main" onClick={() => (e.dir ? onOpenDir(e.path) : onOpenFile(e.path))}>
              <span className="list-icon">{iconFor(e)}</span>
              <span className="list-title">{e.name}</span>
              {e.dir && <span className="list-chevron">›</span>}
            </button>
            <button className="list-more" onClick={() => setMenu(menu === e.path ? null : e.path)} aria-label={`Actions for ${e.name}`}><MoreIcon /></button>
            {menu === e.path && (
              <div className="row-menu">
                <button onClick={() => rename(e)}>Rename</button>
                {!e.dir && <button onClick={() => duplicate(e)}>Duplicate</button>}
                <button className="destructive" onClick={() => remove(e)}>Delete</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
