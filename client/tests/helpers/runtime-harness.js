import { readFileSync } from "node:fs";

export function loadRuntime() {
  const src = readFileSync(
    new URL("../../src/sdk/anymaps.js", import.meta.url), "utf8");
  const fakeSelf = {};
  const posted = [];
  const postMessage = (msg) => posted.push(msg);
  // Worker semantics: inside a worker, self === globalThis. Shadow the real
  // Node globalThis with fakeSelf so the runtime's globalThis.anymaps
  // assignment lands on the sandbox object.
  const fn = new Function("self", "postMessage", "globalThis", src);
  fn(fakeSelf, postMessage, fakeSelf);
  // fakeSelf.onmessage is set by the runtime; simulate a message:
  const receive = (data) => fakeSelf.onmessage({ data });
  return { anymaps: fakeSelf.anymaps, posted, receive, postMessage };
}
