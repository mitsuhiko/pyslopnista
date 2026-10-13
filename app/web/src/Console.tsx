// Console: program output (stdout/stderr/images), input() and the >>> prompt.
import { useEffect, useRef, useState } from "react";
import type { SessionState } from "./session";
import { session } from "./session";

export function Console({ state }: { state: SessionState }) {
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Stick to the bottom while output streams in.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.lines, state.awaitingInput]);

  useEffect(() => {
    if (state.awaitingInput) inputRef.current?.focus();
  }, [state.awaitingInput]);

  const submit = () => {
    if (state.awaitingInput) {
      session.submitInput(value);
    } else {
      if (!value.trim()) return;
      setHistory((h) => [...h, value]);
      void session.runConsole(value);
    }
    setValue("");
    setHistoryIndex(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (!state.awaitingInput && (e.key === "ArrowUp" || e.key === "ArrowDown") && history.length) {
      e.preventDefault();
      const next = e.key === "ArrowUp" ? (historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)) : historyIndex + 1;
      if (next >= history.length || next < 0) {
        setHistoryIndex(-1);
        setValue("");
      } else {
        setHistoryIndex(next);
        setValue(history[next]);
      }
    }
  };

  const busy = state.status !== "idle" && !state.awaitingInput;
  const prompt = state.awaitingInput ? "" : ">>>";

  return (
    <div className="console">
      <div className="console-output" ref={scroller}>
        {state.lines.length === 0 && <div className="console-empty">Output appears here. Type Python below to try things out.</div>}
        {state.lines.map((line) =>
          line.kind === "image" ? (
            <img key={line.id} className="console-image" src={`data:image/png;base64,${line.text}`} alt="plot" />
          ) : line.kind === "prompt" ? (
            <pre key={line.id} className="console-line prompt">{`>>> ${line.text}`}</pre>
          ) : (
            <pre key={line.id} className={`console-line ${line.kind}`}>{line.text}</pre>
          ),
        )}
      </div>
      <div className={`console-input ${state.awaitingInput ? "awaiting" : ""}`}>
        <span className="console-prompt">{prompt}</span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={state.awaitingInput ? "Input for the program, then Return" : busy ? "Running…" : "Python"}
          disabled={busy}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint={state.awaitingInput ? "send" : "go"}
        />
      </div>
    </div>
  );
}
