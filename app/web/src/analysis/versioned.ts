// The analysis service as the engine offers it: every file is checked against
// the Python it runs on (D37), so ty knows which standard library applies and
// ruff which syntax. The version follows the file's folder (.python-version,
// pyproject.toml) and its PEP 723 block.
import { dirname } from "../host";
import { chooseFor, forgetFolders, getDefaultPython } from "../runtimes";
import type { AnalysisApi } from "./api";
import { analysis as client } from "./client";

async function forFile(path: string, text?: string) {
  if (path.startsWith("ext:")) return;
  const choice = await chooseFor(dirname(path), text);
  // Sent every time: a restarted worker starts over at its own default.
  await client.setPython(choice.ok ? choice.python : getDefaultPython());
}

export const versionedAnalysis: AnalysisApi = {
  init: () => client.init(),
  sync: (files) => client.sync(files),
  check: async (path, text) => (await forFile(path, text), client.check(path, text)),
  complete: async (path, text, line, column) => (await forFile(path, text), client.complete(path, text, line, column)),
  hover: async (path, text, line, column) => (await forFile(path, text), client.hover(path, text, line, column)),
  definition: async (path, text, line, column) => (await forFile(path, text), client.definition(path, text, line, column)),
  source: (path) => client.source(path),
  state: () => client.state(),
  setRoot: (dir) => {
    // The host calls this when the folder or its Python files change.
    forgetFolders();
    return client.setRoot(dir);
  },
  format: (text) => client.format(text),
};
