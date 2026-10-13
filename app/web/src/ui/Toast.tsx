// Small transient confirmation capsule ("Formatted", "Copied", ...).
import { useEffect, useState } from "react";

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

export function toast(message: string) {
  for (const fn of listeners) fn(message);
}

export function ToastHost() {
  const [message, setMessage] = useState<string | null>(null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    const fn: Listener = (m) => {
      setMessage(m);
      setKey((k) => k + 1);
    };
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 1700);
    return () => clearTimeout(t);
  }, [message, key]);

  return message ? (
    <div className="toast" key={key} role="status">
      {message}
    </div>
  ) : null;
}
