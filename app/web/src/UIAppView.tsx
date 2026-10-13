// Full-screen view for programs using the ui module (D14).
import { useEffect, useRef } from "react";
import { session } from "./session";
import { UIRenderer } from "./uiRenderer.js";
import "./ui-toolkit.css";

export function UIAppView() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const renderer = new UIRenderer(root.current!, (id: string, args: string) => session.sendUIEvent(id, args));
    (window as any).__uiRenderer = renderer;
    return session.attachUI((json) => {
      if (json) renderer.render(json);
      else renderer.clear();
    });
  }, []);

  return (
    <div className="ui-app">
      <div className="ui-app-content ui-root" ref={root} />
      <button className="ui-app-close" onClick={() => session.closeUI()}>Done</button>
    </div>
  );
}
