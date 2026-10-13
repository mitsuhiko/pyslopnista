// iOS-style popover menu, rendered into document.body so nothing clips it.
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type MenuSection = MenuItem[];

interface Props {
  anchor: DOMRect | { x: number; y: number };
  sections: MenuSection[];
  onClose: () => void;
  align?: "start" | "end";
}

export function Menu({ anchor, sections, onClose, align = "end" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = document.documentElement.clientHeight;
    const rect = "width" in anchor ? anchor : new DOMRect(anchor.x, anchor.y, 0, 0);
    let left = align === "end" ? rect.right - width : rect.left;
    left = Math.max(8, Math.min(left, vw - width - 8));
    let top = rect.bottom + 8;
    let originY = "top";
    if (top + height > vh - 8) {
      top = Math.max(8, rect.top - height - 8);
      originY = "bottom";
    }
    setPos({ left, top, origin: `${align === "end" ? "right" : "left"} ${originY}` });
  }, [anchor, align]);

  return createPortal(
    <div
      className="menu-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        ref={ref}
        className={`menu ${pos ? "open" : ""}`}
        role="menu"
        style={pos ? { left: pos.left, top: pos.top, transformOrigin: pos.origin } : { visibility: "hidden" }}
      >
        {sections.map((items, i) => (
          <div className="menu-section" key={i}>
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                className={`menu-item ${item.destructive ? "destructive" : ""}`}
                disabled={item.disabled}
                onClick={() => {
                  onClose();
                  item.onSelect();
                }}
              >
                <span className="menu-label">{item.label}</span>
                {item.icon && <span className="menu-icon">{item.icon}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
