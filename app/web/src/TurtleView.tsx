// A turtle screen inline in the console (D29): fits the console's width (and
// its height, so the whole drawing stays in view), never scaled up. Taps and
// keys go to the program while it has handlers for them.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { drawScene, keysym, type TurtleScene, turtleScenes } from "./turtle";

const MIN_HEIGHT = 160;
const ROOM_ABOVE = 56; // the sticky run header and some margin

export function TurtleView({ sceneKey }: { sceneKey: string }) {
  const scene = turtleScenes.get(sceneKey);
  return scene ? <TurtleCanvas scene={scene} /> : null;
}

function TurtleCanvas({ scene }: { scene: TurtleScene }) {
  useSyncExternalStore(
    (fn) => scene.subscribe((change) => change === "info" && fn()),
    () => scene.version,
  );
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pressed = useRef(false);
  const [room, setRoom] = useState({ w: 0, h: Infinity });

  useLayoutEffect(() => {
    const el = wrap.current!;
    const scroller = el.closest<HTMLElement>(".console-output");
    const measure = () => setRoom({ w: el.clientWidth, h: scroller ? scroller.clientHeight - ROOM_ABOVE : Infinity });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (scroller) observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const { w, h, title } = scene.info;
  const scale = room.w ? Math.min(1, room.w / w, Math.max(MIN_HEIGHT, room.h) / h) : 0;
  const dpr = window.devicePixelRatio || 1;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !scale) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      drawScene(c, scene, scale, dpr);
    };
    draw();
    const off = scene.subscribe((change) => {
      if (change === "focus") c.focus({ preventScroll: true });
      else if (!frame) frame = requestAnimationFrame(draw);
    });
    return () => {
      off();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scene, scale, dpr, w, h]);

  /** A pointer position in the program's canvas units (Tk's: y down). */
  const at = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const s = r.width / w;
    const [x1, y1, x2, y2] = scene.info.region;
    return { x: (e.clientX - r.left) / s - w / 2 + (x1 + x2) / 2, y: (e.clientY - r.top) / s - h / 2 + (y1 + y2) / 2 };
  };
  const button = (e: React.PointerEvent) => (e.button === 1 ? 2 : e.button === 2 ? 3 : 1);
  const pointer = scene.listening.pointer && scene.accepting;
  const keys = scene.listening.keys && scene.accepting;
  const custom = title && title !== "Python Turtle Graphics";

  return (
    <div className="turtle-view" ref={wrap}>
      {custom && <div className="turtle-title">{title}</div>}
      <canvas
        ref={canvas}
        className={`turtle-canvas ${keys ? "keys" : ""}`}
        width={Math.max(1, Math.round(w * scale * dpr))}
        height={Math.max(1, Math.round(h * scale * dpr))}
        style={{ width: w * scale, height: h * scale, touchAction: pointer ? "none" : "auto" }}
        tabIndex={pointer || keys ? 0 : -1}
        role="img"
        aria-label={title || "Turtle graphics"}
        onPointerDown={(e) => {
          if (!pointer) return;
          canvas.current?.focus({ preventScroll: true });
          try {
            e.currentTarget.setPointerCapture(e.pointerId); // drags that leave the canvas
          } catch {
            // not an active pointer (synthetic events)
          }
          pressed.current = true;
          scene.push({ t: "down", ...at(e), b: button(e) });
        }}
        onPointerMove={(e) => pressed.current && scene.push({ t: "move", ...at(e), b: button(e) })}
        onPointerUp={(e) => {
          if (!pressed.current) return;
          pressed.current = false;
          scene.push({ t: "up", ...at(e), b: button(e) });
        }}
        onPointerCancel={(e) => {
          if (!pressed.current) return;
          pressed.current = false;
          scene.push({ t: "up", ...at(e), b: button(e) });
        }}
        onContextMenu={(e) => pointer && e.preventDefault()}
        onKeyDown={(e) => {
          if (!keys || e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          e.stopPropagation();
          scene.push({ t: "key", k: keysym(e.key) });
        }}
        onKeyUp={(e) => {
          if (!keys || e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          scene.push({ t: "keyup", k: keysym(e.key) });
        }}
      />
    </div>
  );
}
