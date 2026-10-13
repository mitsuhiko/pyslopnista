import { runTest } from "./tests.js";

onmessage = async (e) => postMessage(await runTest(e.data));
