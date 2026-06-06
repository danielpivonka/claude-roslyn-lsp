#!/usr/bin/env node
/*
 * Integration test for the roslyn-lsp-proxy.
 *
 * Drives the proxy with a STANDARD LSP handshake only (no manual solution/open)
 * against the two-project fixture (App -> Lib), then asserts the proxy made
 * Roslyn load the workspace and resolve cross-project semantics:
 *
 *   - workspace/projectInitializationComplete is received
 *   - workspace/symbol "Greeter" returns >= 1
 *   - textDocument/references on the Greeter class returns >= 2
 *     (declaration in Lib + usage in App = cross-project)
 *
 * Exit code 0 on PASS, 1 on FAIL. Requires: node and dotnet. The proxy
 * acquires the Roslyn server itself from NuGet (cached after first run), or
 * uses ROSLYN_LSP_DLL if set. No VS Code or C# extension required.
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const url = require("url");

const ROOT = path.resolve(__dirname, "..");
const PROXY = path.join(ROOT, "plugins", "roslyn-csharp", "bin", "roslyn-lsp-proxy.js");
const FIXTURE = path.join(ROOT, "test", "fixture");
const GREETER = path.join(FIXTURE, "src", "Lib", "Greeter.cs");

const toUri = (p) => url.pathToFileURL(p).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc;
const incoming = []; // received JSON messages, FIFO
let closed = false;
let _id = 0;
const nid = () => ++_id;

function send(msg) {
  const data = Buffer.from(JSON.stringify(msg), "utf8");
  proc.stdin.write(Buffer.from(`Content-Length: ${data.length}\r\n\r\n`, "ascii"));
  proc.stdin.write(data);
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

// Pull the next message matching `pred` within `timeoutMs` (null on timeout/close).
// Auto-replies to server->client requests, like a minimal client would.
async function pump(pred, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (incoming.length === 0) {
      if (closed) return null;
      await sleep(20);
      continue;
    }
    const msg = incoming.shift();
    if (msg && msg.id !== undefined && msg.method !== undefined) {
      // server -> client request: answer so the handshake can proceed
      const items = (msg.params && msg.params.items) || [];
      const result = msg.method === "workspace/configuration" ? items.map(() => null) : null;
      send({ jsonrpc: "2.0", id: msg.id, result });
      continue;
    }
    if (pred(msg)) return msg;
  }
  return null;
}

async function req(method, params, timeoutMs = 30000) {
  const id = nid();
  send({ jsonrpc: "2.0", id, method, params });
  return pump((m) => m.id === id && m.method === undefined, timeoutMs);
}

// Parse the proxy's stdout into framed JSON messages (same wire format the proxy
// itself reads — Content-Length headers + CRLFCRLF separator).
function startReader(stream) {
  let buf = Buffer.alloc(0);
  stream.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buf.subarray(0, headerEnd).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      const total = headerEnd + 4 + len;
      if (buf.length < total) break;
      const body = buf.subarray(headerEnd + 4, total);
      buf = buf.subarray(total);
      try { incoming.push(JSON.parse(body.toString("utf8"))); } catch {}
    }
  });
  stream.on("end", () => { closed = true; });
}

async function main() {
  if (!fs.existsSync(PROXY)) {
    console.log(`FAIL: proxy not found at ${PROXY}`);
    return 1;
  }
  proc = spawn(process.execPath, [PROXY], { cwd: FIXTURE, stdio: ["pipe", "pipe", "inherit"] });
  proc.on("exit", () => { closed = true; });
  startReader(proc.stdout);

  const init = await req("initialize", {
    processId: process.pid,
    rootUri: toUri(FIXTURE),
    workspaceFolders: [{ uri: toUri(FIXTURE), name: "fixture" }],
    capabilities: { workspace: { configuration: true, workspaceFolders: true } },
  }, 60000);
  if (!(init && init.result)) {
    console.log("FAIL: no initialize response");
    proc.kill();
    return 1;
  }
  notify("initialized", {});
  notify("textDocument/didOpen", {
    textDocument: {
      uri: toUri(GREETER), languageId: "csharp", version: 1,
      text: fs.readFileSync(GREETER, "utf8"),
    },
  });

  const initDone = await pump((m) => m.method === "workspace/projectInitializationComplete", 180000);
  await sleep(2000);

  const ws = await req("workspace/symbol", { query: "Greeter" }, 30000);
  const nWs = ws && ws.result ? ws.result.length : 0;
  const refs = await req("textDocument/references", {
    textDocument: { uri: toUri(GREETER) },
    position: { line: 2, character: 13 }, // 'Greeter' in 'public class Greeter'
    context: { includeDeclaration: true },
  }, 30000);
  const nRefs = refs && refs.result ? refs.result.length : 0;
  proc.kill();

  const okInit = initDone !== null;
  const okWs = nWs >= 1;
  const okRefs = nRefs >= 2;
  console.log(`  projectInitializationComplete : ${okInit ? "ok" : "MISSING"}`);
  console.log(`  workspace/symbol 'Greeter'    : ${nWs} (need >=1)`);
  console.log(`  references (cross-project)     : ${nRefs} (need >=2)`);
  if (okInit && okWs && okRefs) {
    console.log("PASS");
    return 0;
  }
  console.log("FAIL");
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.log("FAIL:", e && e.message ? e.message : e);
    try { if (proc) proc.kill(); } catch {}
    process.exit(1);
  });
