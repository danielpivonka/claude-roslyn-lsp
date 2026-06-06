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
 *   - ensures the Roslyn server binary is present (see ACQUISITION below),
 *   - launches it (`dotnet <dll> --stdio ...`),
 *   - forwards every byte in both directions verbatim,
 *   - and, immediately after it sees the client's `initialized` notification,
 *     injects `solution/open` for the workspace's `.sln` (falling back to
 *     `project/open` over discovered `.csproj` files).
 *
 * ACQUISITION (cross-platform, license-clean)
 * -------------------------------------------
 * 1. ROSLYN_LSP_DLL env var, if set and existing (offline / custom builds).
 * 2. A cached copy under the user cache dir.
 * 3. Otherwise: download the framework-dependent `neutral` build of
 *    `Microsoft.CodeAnalysis.LanguageServer` from Microsoft's public NuGet feed
 *    (the same MIT-licensed Roslyn build other editor integrations use), extract
 *    it to the cache, and run it via `dotnet`. One artifact for every OS.
 *
 * The server binary is never bundled or redistributed by this project.
 *
 * Env overrides: ROSLYN_LSP_DLL, ROSLYN_LSP_VERSION, ROSLYN_FEED_INDEX,
 * ROSLYN_FEED_BASE, DOTNET_PATH. All logging goes to stderr only.
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const url = require("url");
const https = require("https");
const zlib = require("zlib");

// Pinned, known-good Roslyn LS version (override with ROSLYN_LSP_VERSION).
const DEFAULT_VERSION = "5.4.0-2.26179.14";
const DEFAULT_FEED =
  "https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/index.json";
const PKG_ID = "microsoft.codeanalysis.languageserver.neutral";
const PKG_PREFIX = "content/LanguageServer/neutral/";

function log(...a) {
  process.stderr.write("[roslyn-lsp-proxy] " + a.join(" ") + "\n");
}

// ---- HTTP (with redirect support) -------------------------------------------
function httpsGet(u) {
  return new Promise((resolve, reject) => {
    https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(httpsGet(new URL(res.headers.location, u).href));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ---- minimal ZIP extractor (deflate/stored) using only built-ins ------------
function extractZip(buf, destDir, prefix) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory header");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (prefix && !name.startsWith(prefix)) continue;
    if (name.endsWith("/")) continue;
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("bad local file header");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? comp : zlib.inflateRawSync(comp);
    const rel = prefix ? name.slice(prefix.length) : name;
    const outPath = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
  }
}

// ---- acquire the Roslyn server dll ------------------------------------------
function cacheRoot() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  return path.join(os.homedir(), ".cache");
}

async function resolvePackageBase() {
  if (process.env.ROSLYN_FEED_BASE) return process.env.ROSLYN_FEED_BASE;
  const idx = JSON.parse((await httpsGet(process.env.ROSLYN_FEED_INDEX || DEFAULT_FEED)).toString("utf8"));
  const r = (idx.resources || []).find((x) => String(x["@type"]).startsWith("PackageBaseAddress/3.0.0"));
  if (!r) throw new Error("PackageBaseAddress not found in NuGet feed index");
  return r["@id"];
}

async function ensureRoslynDll() {
  const override = process.env.ROSLYN_LSP_DLL;
  if (override) {
    if (fs.existsSync(override)) return override;
    log("WARNING: ROSLYN_LSP_DLL set but not found:", override);
  }
  const version = process.env.ROSLYN_LSP_VERSION || DEFAULT_VERSION;
  const dir = path.join(cacheRoot(), "claude-roslyn-lsp", "roslyn", version);
  const dll = path.join(dir, "Microsoft.CodeAnalysis.LanguageServer.dll");
  if (fs.existsSync(dll)) return dll;

  log(`Roslyn LS ${version} not cached - downloading from NuGet (first run only)...`);
  const base = (await resolvePackageBase()).replace(/\/$/, "");
  const nupkgUrl = `${base}/${PKG_ID}/${version}/${PKG_ID}.${version}.nupkg`;
  const buf = await httpsGet(nupkgUrl);
  log(`downloaded ${(buf.length / 1048576).toFixed(1)} MB; extracting...`);
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  extractZip(buf, tmp, PKG_PREFIX);
  if (!fs.existsSync(path.join(tmp, "Microsoft.CodeAnalysis.LanguageServer.dll"))) {
    throw new Error("extraction did not yield the server dll");
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(tmp, dir);
  log("Roslyn LS ready:", dll);
  return dll;
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
  let dll;
  try {
    dll = await ensureRoslynDll();
  } catch (e) {
    log("FATAL: could not obtain the Roslyn language server:", e.message);
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
