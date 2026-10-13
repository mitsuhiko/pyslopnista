import { fs, join } from "./host";

const EXAMPLES_DIR = "Examples";

/** Copy the bundled examples into Documents/Examples on first launch. */
export async function seedExamples() {
  if (await fs.exists(EXAMPLES_DIR)) return;
  const names: string[] = await (await fetch("/examples/index.json")).json();
  await fs.mkdir(EXAMPLES_DIR);
  for (const name of names) {
    const text = await (await fetch(`/examples/${encodeURIComponent(name)}`)).text();
    await fs.writeText(join(EXAMPLES_DIR, name), text);
  }
}
