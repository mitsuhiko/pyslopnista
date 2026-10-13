// Open files of one editor pane as tabs. Tap to switch, × to close, long-press
// (or right-click) for more. External files (stdlib, runtime stubs) are read-only.
import { useEffect, useRef } from "react";
import { basename } from "./host";
import { Close, Lock, SplitView } from "./Icons";

export const isExternal = (path: string) => path.startsWith("ext:");

export function tabLabel(path: string) {
  return basename(path.replace(/^ext:/, ""));
}

interface Props {
  tabs: string[];
  active: string | null;
  focused: boolean;
  running: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onMenu: (path: string, rect: DOMRect) => void;
  /** The trailing button: split view on (left pane) or close the pane (right pane). */
  trailing?: { label: string; icon: "split" | "close"; onClick: () => void; active?: boolean };
}

const LONG_PRESS_MS = 450;

export function TabBar({ tabs, active, focused, running, onSelect, onClose, onMenu, trailing }: Props) {
  const strip = useRef<HTMLDivElement>(null);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);

  // Keep the active tab visible.
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(".tab.active");
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active, tabs.length]);

  const startPress = (path: string, e: React.PointerEvent) => {
    const target = e.currentTarget as HTMLElement;
    press.current = {
      x: e.clientX,
      y: e.clientY,
      fired: false,
      timer: window.setTimeout(() => {
        if (!press.current) return;
        press.current.fired = true;
        onMenu(path, target.getBoundingClientRect());
      }, LONG_PRESS_MS),
    };
  };
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
  };

  return (
    <div className={`tab-bar ${focused ? "focused" : ""}`} role="tablist">
      <div className="tab-strip" ref={strip} onScroll={cancelPress}>
        {tabs.map((path) => (
          <div
            key={path}
            role="tab"
            aria-selected={path === active}
            className={`tab ${path === active ? "active" : ""} ${isExternal(path) ? "external" : ""}`}
            title={path.replace(/^ext:(vendored:\/\/)?/, "")}
            onPointerDown={(e) => startPress(path, e)}
            onPointerMove={(e) => {
              if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) cancelPress();
            }}
            onPointerUp={cancelPress}
            onPointerCancel={cancelPress}
            onClick={() => {
              if (press.current?.fired) return;
              onSelect(path);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              cancelPress();
              onMenu(path, (e.currentTarget as HTMLElement).getBoundingClientRect());
            }}
          >
            {running === path && <span className="tab-running" aria-label="running" />}
            {isExternal(path) && <Lock size={11} className="tab-lock" />}
            <span className="tab-name">{tabLabel(path)}</span>
            <button
              className="tab-close"
              aria-label={`Close ${tabLabel(path)}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
            >
              <Close size={12} />
            </button>
          </div>
        ))}
      </div>
      {trailing && (
        <button className={`tab-bar-button ${trailing.active ? "active" : ""}`} onClick={trailing.onClick} aria-label={trailing.label} title={trailing.label}>
          {trailing.icon === "split" ? <SplitView size={19} /> : <Close size={15} />}
        </button>
      )}
    </div>
  );
}
