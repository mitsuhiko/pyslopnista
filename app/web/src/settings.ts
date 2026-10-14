// Editor settings (font size, line wrapping). The native host owns and
// persists them (D31) and sends them to each editor page.
export interface Settings {
  fontSize: number; // px
  wrap: boolean;
}

const DEFAULTS: Settings = { fontSize: 15, wrap: true };
export const FONT_SIZES = { min: 11, max: 24 };

class SettingsStore {
  private data = DEFAULTS;
  private listeners = new Set<() => void>();

  constructor() {
    this.apply();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.data;

  update(patch: Partial<Settings>) {
    this.data = { ...this.data, ...patch };
    this.data.fontSize = Math.max(FONT_SIZES.min, Math.min(FONT_SIZES.max, Math.round(this.data.fontSize)));
    this.apply();
    for (const fn of this.listeners) fn();
  }

  private apply() {
    document.documentElement.style.setProperty("--editor-font-size", `${this.data.fontSize}px`);
  }
}

export const settings = new SettingsStore();
