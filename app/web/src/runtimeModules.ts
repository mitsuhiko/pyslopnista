// The Python modules the runtime adds (web/public/runtime/python/): written
// into every interpreter at boot, and shown to ty so imports of them are
// checked and completed.

/** iOS device access (D40): Pythonista's module names, implemented on the native host. */
export const DEVICE_MODULES = [
  "clipboard", "console", "contacts", "dialogs", "haptics", "keychain", "location", "motion", "notification",
  "photos", "reminders", "sound", "speech",
];

/** Modules programs import. */
export const PUBLIC_MODULES = ["ui", "turtle", ...DEVICE_MODULES];

/** Every file in /lib/pyslop. */
export const RUNTIME_FILES = ["_pyslop.py", "_pyslop_debug.py", "_pyslop_notebook.py", "_pyslop_turtle.py", "_pyslop_traceback.py", "_device.py", ...PUBLIC_MODULES.map((m) => `${m}.py`)];
