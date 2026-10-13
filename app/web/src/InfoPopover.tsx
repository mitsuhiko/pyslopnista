// What ty knows about a name (its hover text): the signature or type and the
// docstring. Shown by "Show Info" in the selection menu, the ⋯ menu or ⌥-click.
import { Fragment, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The small Markdown subset ty uses: code fences, `---`, inline code, paragraphs. */
function renderMarkdown(md: string): ReactNode {
  const blocks: ReactNode[] = [];
  const parts = md.split(/^```[a-z]*\n([\s\S]*?)^```\s*$/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      blocks.push(<pre className="info-code" key={i}>{part.replace(/\n$/, "")}</pre>);
      return;
    }
    for (const [j, para] of part.split(/\n\s*\n|^---\s*$/m).entries()) {
      const text = para.trim();
      if (!text || text === "---") continue;
      const inline = text.split(/(`[^`]+`)/).map((chunk, k) =>
        chunk.startsWith("`") && chunk.endsWith("`") ? <code key={k}>{chunk.slice(1, -1)}</code> : <Fragment key={k}>{chunk}</Fragment>,
      );
      blocks.push(<p className="info-text" key={`${i}-${j}`}>{inline}</p>);
    }
  });
  return blocks;
}

export function InfoPopover({ markdown, anchor, onClose }: { markdown: string | null; anchor: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = document.documentElement.clientHeight;
    const left = Math.max(8, Math.min(anchor.left, vw - width - 8));
    const below = anchor.bottom + 8;
    const top = below + height > vh - 8 && anchor.top - height - 8 > 8 ? anchor.top - height - 8 : below;
    setPos({ left, top });
  }, [anchor, markdown]);

  return createPortal(
    <div className="menu-scrim" onPointerDown={onClose}>
      <div
        ref={ref}
        className={`value-popover info-popover ${pos ? "open" : ""}`}
        style={pos ?? { left: -9999, top: 0 }}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Info"
      >
        {markdown === null ? <div className="value-loading"><span className="spinner" /></div> : markdown ? renderMarkdown(markdown) : <p className="info-text muted">No information.</p>}
      </div>
    </div>,
    document.body,
  );
}
