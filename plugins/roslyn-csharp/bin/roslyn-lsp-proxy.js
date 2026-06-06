#!/usr/bin/env node
/*
 * roslyn-lsp-proxy: bridges a generic LSP client (e.g. Claude Code) to
 * Microsoft's Roslyn language server (Microsoft.CodeAnalysis.LanguageServer).
 *
 * WHY THIS EXISTS
 * ---------------
 * The Roslyn language server does NOT load a workspace from the standard LSP
 * `initialize`/`rootUri`. It waits for the editor's *proprietary* `solution/open`
 * notification (or `project/open`). A generic LSP client never sends those, so a
 * directly-wired Roslyn server loads zero projects and returns empty results.
 *
 * This proxy sits on stdio between the client and Roslyn:
 *   - launches the Roslyn server (`dotnet <dll> --stdio ...`),
 *   - forwards every byte in both directions verbatim,
 *   - and, immediately after it sees the client's `initialized` notification,
 *     injects `solution/open` for the workspace's `.sln` (falling back to
 *     `project/open` over discovered `.csproj` files if there is no solution).
 *
 * The Roslyn binary is auto-discovered from an installed VS Code C# extension
 * (`ms-dotnettools.csharp-*`). Override with the ROSLYN_LSP_DLL env var.
 *
 * All diagnostic logging goes to stderr / a temp log dir ONLY — never stdout,
 * which is the LSP channel.
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

// ---- locate the newest installed Roslyn language server ---------------------
function findRoslynDll() {
  const envDll = process.env.ROSLYN_LSP_DLL;
  if (envDll) {
    if (fs.existsSync(envDll)) return envDll;
    log("WARNING: ROSLYN_LSP_DLL set but not found:", envDll);
  }
  const home = os.homedir();
  const extRoots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".vscode-server", "extensions"),
    path.join(home, ".vscode-oss", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".windsurf", "extensions"),
  ];
  const candidates = [];
  for (const root of extRoots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const e of entries) {
      if (!e.startsWith("ms-dotnettools.csharp-")) continue;
      const dll = path.join(root, e, ".roslyn", "Microsoft.CodeAnalysis.LanguageServer.dll");
      if (fs.existsSync(dll)) candidates.push({ dir: e, dll });
    }
  }
  if (candidates.length === 0) return null;
  // newest version (by the x.y.z embedded in the extension dir name) wins
  const ver = (s) => (s.match(/csharp-(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
  candidates.sort((a, b) => {
    const va = ver(a.dir), vb = ver(b.dir);
    for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
    return 0;
  });
  return candidates[candidates.length - 1].dll;
}

// ---- discover the workspace to open -----------------------------------------
function discoverWorkspace(rootDir) {
  const slns = [], csprojs = [];
  try {
    for (const f of fs.readdirSync(rootDir)) {
      if (f.toLowerCase().endsWith(".sln") || f.toLowerCase().endsWith(".slnx")) {
        slns.push(path.join(rootDir, f));
      }
    }
  } catch {}
  if (slns.length === 0) {
    const skip = new Set(["bin", "obj", ".git", "node_modules", ".godot", ".vs"]);
    const walk = (d, depth) => {
      if (depth > 3) return;
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !skip.has(e.name)) walk(p, depth + 1);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".csproj")) csprojs.push(p);
      }
    };
    walk(rootDir, 0);
  }
  return { slns, csprojs };
}

const toUri = (p) => url.pathToFileURL(p).href;

// ---- launch Roslyn ----------------------------------------------------------
const dll = findRoslynDll();
if (!dll) {
  log("FATAL: Microsoft.CodeAnalysis.LanguageServer.dll not found.");
  log("Install the VS Code C# extension (ms-dotnettools.csharp) or set ROSLYN_LSP_DLL.");
  process.exit(1);
}
log("roslyn dll:", dll);

const logDir = path.join(os.tmpdir(), "roslyn-lsp-proxy-logs");
try { fs.mkdirSync(logDir, { recursive: true }); } catch {}

const dotnet = process.env.DOTNET_PATH || "dotnet";
const child = spawn(dotnet, [dll, "--stdio", "--logLevel", "Information",
  "--extensionLogDirectory", logDir], { stdio: ["pipe", "pipe", "pipe"] });

child.on("error", (e) => { log("FATAL: failed to spawn dotnet:", e.message); process.exit(1); });
child.on("exit", (code) => { log("roslyn exited", code); process.exit(code || 0); });
child.stderr.on("data", (d) => log("roslyn:", d.toString().trimEnd()));

// server -> client: straight passthrough
child.stdout.pipe(process.stdout);

// client -> server: parse frames so we can inject solution/open at the right time
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
  child.stdin.write(frame); // forward original bytes verbatim
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
    const header = buf.slice(0, headerEnd).toString("ascii");
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) { buf = buf.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    const total = headerEnd + 4 + len;
    if (buf.length < total) break;
    const frame = buf.slice(0, total);
    const body = buf.slice(headerEnd + 4, total);
    buf = buf.slice(total);
    handleClientFrame(frame, body);
  }
});

process.stdin.on("end", () => { try { child.stdin.end(); } catch {} });
