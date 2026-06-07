#!/usr/bin/env node
/*
 * roslyn-lsp-proxy: bridges a generic LSP client (e.g. Claude Code) to
 * Microsoft's Roslyn language server.
 *
 * WHY THIS EXISTS
 * ---------------
 * Roslyn does NOT load a workspace from the standard LSP `initialize`/`rootUri`.
 * It waits for the editor's *proprietary* `solution/open` notification (or
 * `project/open`). A generic LSP client never sends those, so a directly-wired
 * Roslyn server loads zero projects and returns empty results.
 *
 * This proxy sits on stdio between the client and Roslyn, forwards every byte
 * in both directions verbatim, and injects `solution/open` immediately after
 * the client's `initialized` notification.
 *
 * AUTO-RESTART
 * ------------
 * Roslyn can crash (e.g. unhandled exceptions in request handlers). The proxy
 * detects these exits, immediately fails in-flight requests so the client is
 * not left hanging, and transparently restarts Roslyn up to MAX_RESTARTS times
 * by replaying the initialize handshake internally – the client never sees a
 * disconnect.
 *
 * PREREQUISITES
 * -------------
 * Install the server once as a dotnet global tool:
 *
 *   dotnet tool install -g roslyn-language-server --prerelease \
 *     --add-source https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/index.json
 *
 * Keep it current with:
 *   dotnet tool update -g roslyn-language-server --prerelease \
 *     --add-source https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/index.json
 *
 * All logging goes to stderr only.
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url = require("url");

function log(...a) {
  process.stderr.write("[roslyn-lsp-proxy] " + a.join(" ") + "\n");
}

const toUri = (p) => url.pathToFileURL(p).href;

function discoverWorkspace(rootDir) {
  const slns = [], csprojs = [];
  try {
    for (const f of fs.readdirSync(rootDir)) {
      const l = f.toLowerCase();
      if (l.endsWith(".sln") || l.endsWith(".slnx")) slns.push(path.join(rootDir, f));
    }
  } catch {}
  if (slns.length === 0) {
    const skip = new Set(["bin", "obj", ".git", "node_modules", ".godot", ".vs"]);
    const walk = (d, depth) => {
      if (depth > 3) return;
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const fp = path.join(d, e.name);
        if (e.isDirectory() && !skip.has(e.name)) walk(fp, depth + 1);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".csproj")) csprojs.push(fp);
      }
    };
    walk(rootDir, 0);
  }
  return { slns, csprojs };
}

// Parse as many complete LSP frames from buf as possible, calling onFrame for
// each. Returns the unconsumed remainder.
function parseFrames(buf, onFrame) {
  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buf.subarray(0, headerEnd).toString("ascii");
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    const total = headerEnd + 4 + len;
    if (buf.length < total) break;
    onFrame(buf.subarray(0, total), buf.subarray(headerEnd + 4, total));
    buf = buf.subarray(total);
  }
  return buf;
}

// Sentinel request id used when replaying initialize to a restarted server.
// The response is intercepted and not forwarded to the client.
const RESTART_INIT_ID = "__roslyn_proxy_restart_init__";
const MAX_RESTARTS = 5;

async function main() {
  const logDir = path.join(os.tmpdir(), "roslyn-lsp-proxy-logs");
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}

  const cmd = "roslyn-language-server";
  const roslynArgs = ["--stdio", "--logLevel", "Information", "--extensionLogDirectory", logDir];

  // Client-session state
  let pendingInitId = null; // id of the client's initialize request (null once answered)
  let savedInitMsg = null;  // saved for restart replay
  let rootDir = process.cwd();

  // Child process
  let child = null;
  let spawnError = null;
  let errorReported = false;
  let injected = false;

  // Restart state
  let isRestarting = false;
  let awaitingRestartInitResp = false;
  let restartCount = 0;
  let frameQueue = []; // raw client frames buffered while server is restarting

  // In-flight client requests (id -> true); used to send errors on crash
  const pendingRequests = new Map();

  function sendToClient(obj) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  }

  function writeToServer(obj) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    child.stdin.write(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"));
    child.stdin.write(body);
  }

  function failPendingRequests(reason) {
    for (const id of pendingRequests.keys()) {
      sendToClient({ jsonrpc: "2.0", id, error: { code: -32099, message: reason } });
    }
    pendingRequests.clear();
  }

  function injectWorkspaceOpen() {
    if (injected) return;
    injected = true;
    const { slns, csprojs } = discoverWorkspace(rootDir);
    if (slns.length > 0) {
      const base = path.basename(rootDir).toLowerCase();
      const pick = slns.find((s) => path.basename(s).replace(/\.slnx?$/i, "").toLowerCase() === base) || slns[0];
      log("injecting solution/open:", pick);
      writeToServer({ jsonrpc: "2.0", method: "solution/open", params: { solution: toUri(pick) } });
    } else if (csprojs.length > 0) {
      log("no .sln; injecting project/open for", csprojs.length, "project(s)");
      writeToServer({ jsonrpc: "2.0", method: "project/open", params: { projects: csprojs.map(toUri) } });
    } else {
      log("WARNING: no .sln/.csproj found under", rootDir, "- Roslyn will load nothing");
    }
  }

  function reportFatalError(e) {
    if (errorReported) return;
    errorReported = true;
    const msg = e.code === "ENOENT"
      ? "roslyn-language-server not found. Install with:\n" +
        "  dotnet tool install -g roslyn-language-server --prerelease \\\n" +
        "    --add-source https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/index.json"
      : `Failed to start roslyn-language-server: ${e.message}`;
    log("FATAL:", msg.split("\n")[0]);
    if (pendingInitId !== null) {
      sendToClient({ jsonrpc: "2.0", id: pendingInitId, error: { code: -32099, message: msg } });
    }
    sendToClient({ jsonrpc: "2.0", method: "window/showMessage", params: { type: 1, message: msg } });
    process.exit(1);
  }

  function handleServerFrame(frame, body) {
    let msg;
    try { msg = JSON.parse(body.toString("utf8")); } catch { msg = null; }

    // Intercept the internal restart initialize response – don't forward to client
    if (awaitingRestartInitResp && msg && msg.id === RESTART_INIT_ID) {
      awaitingRestartInitResp = false;
      writeToServer({ jsonrpc: "2.0", method: "initialized", params: {} });
      injectWorkspaceOpen();
      isRestarting = false;
      restartCount = 0; // reset on successful restart
      log("restart complete, draining", frameQueue.length, "queued frame(s)");
      const queued = frameQueue.splice(0);
      for (const qf of queued) child.stdin.write(qf);
      return; // do not forward to client
    }

    if (msg && msg.id !== undefined && msg.id !== null) {
      if (msg.id === pendingInitId) pendingInitId = null;
      pendingRequests.delete(msg.id);
    }

    process.stdout.write(frame);
  }

  function spawnRoslyn() {
    injected = false;
    spawnError = null;
    let serverBuf = Buffer.alloc(0);

    child = spawn(cmd, roslynArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      // On Windows, dotnet global tools are .cmd batch scripts that need a shell.
      shell: process.platform === "win32",
    });

    child.on("error", (e) => {
      spawnError = e;
      if (pendingInitId !== null || restartCount > 0) {
        reportFatalError(e);
      } else {
        setTimeout(() => { if (!errorReported) reportFatalError(e); }, 2000);
      }
    });

    child.on("exit", (code) => {
      log("roslyn exited with code", code);
      if (code === 0) { process.exit(0); }
      if (restartCount >= MAX_RESTARTS) {
        log("giving up after", MAX_RESTARTS, "restarts");
        failPendingRequests(`Roslyn crashed too many times (last exit code ${code})`);
        sendToClient({
          jsonrpc: "2.0",
          method: "window/showMessage",
          params: {
            type: 1,
            message: `roslyn-language-server crashed ${MAX_RESTARTS} times. ` +
              `Check logs in ${logDir} and restart manually.`,
          },
        });
        process.exit(code);
      }
      restartCount++;
      const delay = Math.min(1000 * restartCount, 5000);
      log(`crashed (exit code ${code}), restart ${restartCount}/${MAX_RESTARTS} in ${delay}ms`);
      failPendingRequests(`Roslyn crashed (exit code ${code}), restarting...`);
      isRestarting = true;
      frameQueue = [];
      setTimeout(doRestart, delay);
    });

    child.stderr.on("data", (d) => log("roslyn:", d.toString().trimEnd()));
    child.stdin.on("error", () => {});

    child.stdout.on("data", (d) => {
      serverBuf = Buffer.concat([serverBuf, d]);
      serverBuf = parseFrames(serverBuf, handleServerFrame);
    });
  }

  function doRestart() {
    log("restarting roslyn-language-server...");
    spawnRoslyn();
    if (savedInitMsg) {
      // Replay initialize with a sentinel id so the response can be intercepted.
      awaitingRestartInitResp = true;
      const replayMsg = Object.assign({}, savedInitMsg, { id: RESTART_INIT_ID });
      const body = Buffer.from(JSON.stringify(replayMsg), "utf8");
      child.stdin.write(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"));
      child.stdin.write(body);
    }
  }

  spawnRoslyn();

  // client -> server: parse frames so we can inject solution/open and manage restarts
  let clientBuf = Buffer.alloc(0);
  process.stdin.on("data", (d) => {
    clientBuf = Buffer.concat([clientBuf, d]);
    clientBuf = parseFrames(clientBuf, (frame, body) => {
      let msg;
      try { msg = JSON.parse(body.toString("utf8")); } catch { msg = null; }

      if (msg) {
        if (msg.method === "initialize") {
          pendingInitId = msg.id;
          savedInitMsg = msg;
          const p = msg.params || {};
          let dir = null;
          if (p.rootUri) { try { dir = url.fileURLToPath(p.rootUri); } catch {} }
          if (!dir && p.rootPath) dir = p.rootPath;
          if (!dir && Array.isArray(p.workspaceFolders) && p.workspaceFolders[0]) {
            try { dir = url.fileURLToPath(p.workspaceFolders[0].uri); } catch {} }
          if (dir) { rootDir = dir; log("workspace root:", rootDir); }
          if (spawnError) { reportFatalError(spawnError); return; }
        } else if (msg.method === "initialized") {
          injectWorkspaceOpen();
        }
      }

      // Buffer frames while the server is restarting
      if (isRestarting) {
        frameQueue.push(frame);
        return;
      }

      // Track requests (messages with both id and method are requests, not notifications)
      if (msg && msg.id !== undefined && msg.id !== null && msg.method) {
        pendingRequests.set(msg.id, true);
      }

      if (!spawnError) child.stdin.write(frame);
    });
  });

  process.stdin.on("end", () => { try { child.stdin.end(); } catch {} });
}

main();
