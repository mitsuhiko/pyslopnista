// Extra keys above the software keyboard (like Pythonista's). Buttons act on
// pointerdown with preventDefault so the editor keeps focus and the keyboard
// stays up. The track on the left moves the cursor by swiping.
import { useRef } from "react";
import type { EditorCommand, EditorHandle } from "./Editor";

type Key = { label: string; insert?: string; cursor?: number; command?: EditorCommand; wide?: boolean };

const KEYS: Key[] = [
  { label: "⇥", command: "indent", wide: true },
  { label: "⇤", command: "dedent", wide: true },
  { label: ":", insert: ":" },
  { label: "(", insert: "()", cursor: 1 },
  { label: ")", insert: ")" },
  { label: "[", insert: "[]", cursor: 1 },
  { label: "]", insert: "]" },
  { label: "{", insert: "{}", cursor: 1 },
  { label: "\"", insert: "\"\"", cursor: 1 },
  { label: "'", insert: "''", cursor: 1 },
  { label: "=", insert: "=" },
  { label: "_", insert: "_" },
  { label: "#", insert: "# " },
  { label: ".", insert: "." },
  { label: ",", insert: ", " },
  { label: "+", insert: "+" },
  { label: "-", insert: "-" },
  { label: "*", insert: "*" },
  { label: "/", insert: "/" },
  { label: "<", insert: "<" },
  { label: ">", insert: ">" },
  { label: "↶", command: "undo", wide: true },
  { label: "↷", command: "redo", wide: true },
  { label: "//#", command: "comment", wide: true },
];

export function KeyBar({ editor, onDismiss }: { editor: React.RefObject<EditorHandle | null>; onDismiss: () => void }) {
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const press = (key: Key) => (e: React.PointerEvent) => {
    e.preventDefault();
    if (key.command) editor.current?.command(key.command);
    else if (key.insert) editor.current?.insert(key.insert, key.cursor);
  };

  // Swipe horizontally on the track to move the cursor (one char per 12 px).
  const trackDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    swipe.current = { x: e.clientX, y: e.clientY };
  };
  const trackMove = (e: React.PointerEvent) => {
    const s = swipe.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) >= 12) {
      editor.current?.command(dx > 0 ? "right" : "left");
      s.x += Math.sign(dx) * 12;
    } else if (Math.abs(dy) >= 24) {
      editor.current?.command(dy > 0 ? "down" : "up");
      s.y += Math.sign(dy) * 24;
    }
  };
  const trackUp = () => {
    swipe.current = null;
  };

  return (
    <div className="keybar" onPointerDown={(e) => e.preventDefault()}>
      <div className="keybar-track" onPointerDown={trackDown} onPointerMove={trackMove} onPointerUp={trackUp} onPointerCancel={trackUp} title="Swipe to move the cursor">
        ‹ ›
      </div>
      <div className="keybar-keys">
        {KEYS.map((k) => (
          <button key={k.label} className={k.wide ? "key wide" : "key"} onPointerDown={press(k)}>
            {k.label}
          </button>
        ))}
      </div>
      <button className="key dismiss" onPointerDown={(e) => { e.preventDefault(); onDismiss(); }} aria-label="Hide keyboard">
        ⌄
      </button>
    </div>
  );
}
