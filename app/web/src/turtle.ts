// Turtle graphics on the page (D29). A TurtleScene mirrors the items of one
// turtle screen (lines, polygons, images, text: Tk's canvas model, kept in
// _pyslop_turtle.py) from the ops the program sends, queues taps and keys for
// it, and draws itself onto a <canvas> in the console (TurtleView).

export interface TurtleInfo {
  title: string;
  w: number; // the window, in canvas units
  h: number;
  region: [number, number, number, number]; // scroll region; the window shows its middle
  bg: string;
}

type ItemType = "line" | "polygon" | "image" | "text";

interface Item {
  type: ItemType;
  xy: number[];
  o: Record<string, any>;
}

export type TurtleEvent =
  | { t: "down" | "move" | "up"; x: number; y: number; b: number }
  | { t: "key" | "keyup"; k: string };

type Change = "info" | "draw" | "focus";

const MAX_EVENTS = 200;

export class TurtleScene {
  info: TurtleInfo = { title: "Python Turtle Graphics", w: 600, h: 600, region: [-200, -150, 200, 150], bg: "#ffffff" };
  items = new Map<number, Item>(); // in stacking order
  images = new Map<number, { img: HTMLImageElement | null; w: number; h: number }>();
  listening = { pointer: false, keys: false };
  /** The program can still take events (false after bye() or when it ended). */
  live = true;
  /** The program (or console input) is running: only then does anyone read events. */
  active = true;
  /** Bumped when info or listening changes (the view re-renders). */
  version = 0;
  private events: TurtleEvent[] = [];
  private waiter: { wake: () => void; cancel: () => void } | null = null;
  private listeners = new Set<(change: Change) => void>();

  constructor(readonly key: string) {}

  subscribe = (fn: (change: Change) => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private emit(change: Change) {
    for (const fn of this.listeners) fn(change);
  }

  apply(ops: any[]) {
    let info = false;
    let focus = false;
    for (const op of ops) {
      const item = typeof op[1] === "number" ? this.items.get(op[1]) : undefined;
      switch (op[0]) {
        case "open":
        case "screen":
          this.info = { ...this.info, ...op[1] };
          info = true;
          break;
        case "new":
          this.items.set(op[1], { type: op[2], xy: op[3], o: op[4] });
          break;
        case "xy":
          if (item) item.xy = op[2];
          break;
        case "set":
          if (item) Object.assign(item.o, op[2]);
          break;
        case "top":
          if (item) {
            this.items.delete(op[1]);
            this.items.set(op[1], item);
          }
          break;
        case "bottom":
          if (item) this.items = new Map([[op[1] as number, item], ...[...this.items].filter(([id]) => id !== op[1])]);
          break;
        case "del":
          if (op[1] === "all") this.items.clear();
          else this.items.delete(op[1]);
          break;
        case "img":
          this.loadImage(op[1], op[2], op[3], op[4]);
          break;
        case "listen":
          this.listening = op[1];
          this.events = this.events.filter((e) => (e.t === "key" || e.t === "keyup" ? this.listening.keys : this.listening.pointer));
          info = true;
          break;
        case "focus":
          focus = true;
          break;
        case "close":
          this.end();
          info = true;
          break;
      }
    }
    if (info) this.version++;
    this.emit(info ? "info" : "draw");
    if (focus) this.emit("focus");
  }

  private loadImage(id: number, url: string | null, w: number, h: number) {
    const entry = { img: null as HTMLImageElement | null, w, h };
    this.images.set(id, entry);
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      entry.img = img;
      this.emit("draw");
    };
    img.src = url;
  }

  /** A tap or key from the view; kept until the program asks for events. */
  push(e: TurtleEvent) {
    if (!this.live || !this.active) return;
    const key = e.t === "key" || e.t === "keyup";
    if (key ? !this.listening.keys : !this.listening.pointer) return;
    const last = this.events.at(-1);
    if (e.t === "move" && last?.t === "move") this.events[this.events.length - 1] = e;
    else this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.waiter?.wake();
  }

  /** The program asks for events, waiting up to waitMs for the first. */
  take(waitMs: number): Promise<TurtleEvent[]> {
    this.waiter?.cancel(); // an earlier call that was interrupted: its answer is dropped
    if (this.events.length || waitMs <= 0 || !this.live) return Promise.resolve(this.drain());
    return new Promise((resolve) => {
      const finish = (events: TurtleEvent[]) => {
        clearTimeout(timer);
        this.waiter = null;
        resolve(events);
      };
      const timer = setTimeout(() => finish(this.drain()), waitMs);
      this.waiter = { wake: () => finish(this.drain()), cancel: () => finish([]) };
    });
  }

  private drain() {
    const events = this.events;
    this.events = [];
    return events;
  }

  /** Whether code runs in the program's interpreter (the session tells us). */
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (!active) this.events = [];
    this.version++;
    this.emit("info");
  }

  /** Whether taps and keys go to the program right now. */
  get accepting() {
    return this.live && this.active;
  }

  /** bye(), or the program ended: the drawing stays, events stop. */
  end() {
    if (!this.live) return;
    this.live = false;
    this.listening = { pointer: false, keys: false };
    this.events = [];
    this.waiter?.wake();
    this.version++;
    this.emit("info");
  }
}

/** Scenes by key (the console line refers to its scene by key). */
export const turtleScenes = new Map<string, TurtleScene>();

// -- drawing -------------------------------------------------------------------------------

export function drawScene(canvas: HTMLCanvasElement, scene: TurtleScene, scale: number, dpr: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { w, h, region, bg } = scene.info;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = bg || "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const k = scale * dpr;
  const cx = (region[0] + region[2]) / 2;
  const cy = (region[1] + region[3]) / 2;
  ctx.setTransform(k, 0, 0, k, (w / 2 - cx) * k, (h / 2 - cy) * k);
  for (const item of scene.items.values()) {
    const { xy, o } = item;
    switch (item.type) {
      case "line": {
        if (!o.fill || xy.length < 4) break;
        const width = o.width > 0 ? o.width : 1;
        if (xy.every((v, i) => v === xy[i % 2])) {
          // A zero-length line with round caps: dot()
          ctx.fillStyle = o.fill;
          ctx.beginPath();
          ctx.arc(xy[0], xy[1], width / 2, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        ctx.strokeStyle = o.fill;
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        trace(ctx, xy, false);
        ctx.stroke();
        break;
      }
      case "polygon": {
        if (xy.length < 6 || (!o.fill && !o.outline)) break;
        trace(ctx, xy, true);
        if (o.fill) {
          ctx.fillStyle = o.fill;
          ctx.fill("evenodd"); // like Tk: a star's middle stays open
        }
        if (o.outline) {
          ctx.strokeStyle = o.outline;
          ctx.lineWidth = o.width > 0 ? o.width : 1;
          ctx.lineJoin = "miter";
          ctx.stroke();
        }
        break;
      }
      case "image": {
        const img = o.image != null ? scene.images.get(o.image)?.img : null;
        if (img && xy.length >= 2) ctx.drawImage(img, xy[0] - img.naturalWidth / 2, xy[1] - img.naturalHeight / 2);
        break;
      }
      case "text": {
        if (!o.text || xy.length < 2) break;
        ctx.font = o.font || "8pt Arial, sans-serif";
        ctx.fillStyle = o.fill || "#000000";
        ctx.textAlign = o.anchor === "se" ? "right" : o.anchor === "s" ? "center" : "left";
        ctx.textBaseline = "bottom";
        const m = ctx.measureText("Mg");
        const lineHeight = (m.fontBoundingBoxAscent ?? 0) + (m.fontBoundingBoxDescent ?? 0) || 12;
        const lines = String(o.text).split("\n");
        lines.forEach((line, i) => {
          const y = xy[1] - (lines.length - 1 - i) * lineHeight;
          ctx.fillText(line, xy[0], y);
          if (o.underline) {
            const width = ctx.measureText(line).width;
            const x = ctx.textAlign === "right" ? xy[0] - width : ctx.textAlign === "center" ? xy[0] - width / 2 : xy[0];
            ctx.fillRect(x, y - (m.fontBoundingBoxDescent ?? 2) + 1, width, Math.max(1, lineHeight / 16));
          }
        });
        break;
      }
    }
  }
}

function trace(ctx: CanvasRenderingContext2D, xy: number[], close: boolean) {
  ctx.beginPath();
  ctx.moveTo(xy[0], xy[1]);
  for (let i = 2; i + 1 < xy.length; i += 2) ctx.lineTo(xy[i], xy[i + 1]);
  if (close) ctx.closePath();
}

// -- keys ------------------------------------------------------------------------------------

const KEYSYMS: Record<string, string> = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "space", Enter: "Return",
  Backspace: "BackSpace", Escape: "Escape", Tab: "Tab", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End",
  PageUp: "Prior", PageDown: "Next", Shift: "Shift_L", Control: "Control_L", Alt: "Alt_L", Meta: "Meta_L",
  CapsLock: "Caps_Lock", "+": "plus", "-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash",
  ";": "semicolon", ":": "colon", "'": "apostrophe", '"': "quotedbl", "[": "bracketleft", "]": "bracketright",
  "{": "braceleft", "}": "braceright", "\\": "backslash", "|": "bar", "`": "grave", "~": "asciitilde",
  "*": "asterisk", "!": "exclam", "?": "question", "#": "numbersign", $: "dollar", "%": "percent",
  "&": "ampersand", "(": "parenleft", ")": "parenright", _: "underscore", "<": "less", ">": "greater",
  "@": "at", "^": "asciicircum",
};

/** A DOM key as Tk's keysym (what onkey() and onkeypress() take). */
export const keysym = (key: string) => KEYSYMS[key] ?? key;
