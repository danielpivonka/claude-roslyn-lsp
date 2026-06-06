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

// ---- run --------------------------------------------------------------------
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

async function main() {
  const logDir = path.join(os.tmpdir(), "roslyn-lsp-proxy-logs");
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}

  const cmd = "roslyn-language-server";
  const args = ["--stdio", "--logLevel", "Information", "--extensionLogDirectory", logDir];

  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (e) => {
    if (e.code === "ENOENT") {
      log("FATAL: roslyn-language-server not found. Install it with:");
      log("  dotnet tool install -g roslyn-language-server --prerelease \\");
      log("    --add-source https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/index.json");
    } else {
      log("FATAL: failed to spawn roslyn-language-server:", e.message);
    }
    process.exit(1);
  });
  child.on("exit", (code) => { log("roslyn exited", code); process.exit(code || 0); });
  child.stderr.on("data", (d) => log("roslyn:", d.toString().trimEnd()));

  // server -> client: straight passthrough
  child.stdout.pipe(process.stdout);

  // client -> server: parse frames so we can inject solution/open
  let buf = Buffer.alloc(0);
  let rootDir = process.cwd();
  let injected = false;

  function writeToServer(obj) {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    child.stdin.write(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"));
    child.stdin.write(body);
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

  function handleClientFrame(frame, body) {
    child.stdin.write(frame);
    let msg;
    try { msg = JSON.parse(body.toString("utf8")); } catch { return; }
    if (msg.method === "initialize") {
      const p = msg.params || {};
      let dir = null;
      if (p.rootUri) { try { dir = url.fileURLToPath(p.rootUri); } catch {} }
      if (!dir && p.rootPath) dir = p.rootPath;
      if (!dir && Array.isArray(p.workspaceFolders) && p.workspaceFolders[0]) {
        try { dir = url.fileURLToPath(p.workspaceFolders[0].uri); } catch {}
      }
      if (dir) { rootDir = dir; log("workspace root:", rootDir); }
    } else if (msg.method === "initialized") {
      injectWorkspaceOpen();
    }
  }

  process.stdin.on("data", (d) => {
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
      const frame = buf.subarray(0, total);
      const body = buf.subarray(headerEnd + 4, total);
      buf = buf.subarray(total);
      handleClientFrame(frame, body);
    }
  });
  process.stdin.on("end", () => { try { child.stdin.end(); } catch {} });
}

main();
