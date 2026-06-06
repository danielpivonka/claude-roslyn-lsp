# claude-roslyn-lsp

A Claude Code plugin that gives C# code intelligence through **Microsoft's Roslyn
language server** (`Microsoft.CodeAnalysis.LanguageServer` — the same engine the
VS Code C# extension uses), instead of the lighter-weight `csharp-ls`.

It ships a small stdio proxy that solves the one thing that otherwise stops Roslyn
from working under a generic LSP client, and it acquires the server itself — no
VS Code, no manual install, same behaviour on Windows / macOS / Linux.

## Why

Roslyn is the most accurate C# language server and handles file churn (edits,
deletes, renames) far better than `csharp-ls` — no stale "predefined type
System.Object is not defined" diagnostic storms after bulk changes.

**But** Roslyn does *not* load a workspace from the standard LSP
`initialize`/`rootUri`. It waits for the editor's **proprietary** `solution/open`
notification (or `project/open`). A generic LSP client never sends those, so a
directly-wired Roslyn server loads zero projects and returns empty results —
actually *worse* than `csharp-ls`.

Measured against the bundled two-project fixture (no `solution/open` vs. with it):

| query | without `solution/open` | with `solution/open` |
| --- | --- | --- |
| `workspace/symbol "Greeter"` | 0 | 1 |
| `references` (cross-project) | 1 (same file only) | 3 |

## How it works

```
Claude Code ──stdio──▶ roslyn-lsp-proxy.js ──stdio──▶ Microsoft.CodeAnalysis.LanguageServer
                              │
                              └─ after the client's `initialized`, injects
                                 `solution/open` for the workspace's .sln
                                 (falls back to `project/open` over .csproj)
```

On first run the proxy downloads the framework-dependent **`neutral`** build of
`Microsoft.CodeAnalysis.LanguageServer` from Microsoft's public NuGet feed (the
MIT-licensed Roslyn build that other editor integrations use), caches it under
your user cache dir, and runs it with `dotnet`. One artifact for every OS. The
binary is **never bundled or redistributed by this project.**

Then for every session it forwards all LSP traffic verbatim and injects
`solution/open` right after `initialized`. Logs go to stderr /
`<tmp>/roslyn-lsp-proxy-logs` only (never stdout, which is the LSP channel).

## Requirements

- **Node.js** ≥ 18 (the proxy uses only built-ins — no `npm install`).
- **`dotnet`** on `PATH` (override with `DOTNET_PATH`), with a runtime matching the
  pinned Roslyn build's target framework — currently **.NET 10**. If you only have
  an older runtime, pin an older server with `ROSLYN_LSP_VERSION`.
- **Internet access on first run** (to fetch the server; cached thereafter). For
  offline/air-gapped use, set `ROSLYN_LSP_DLL` to a local
  `Microsoft.CodeAnalysis.LanguageServer.dll`.

No VS Code or C# extension required.

## Install (Claude Code)

```
/plugin marketplace add danielpivonka/claude-roslyn-lsp
/plugin install roslyn-csharp@claude-roslyn-lsp
/plugin disable csharp-lsp@claude-plugins-official   # avoid two servers on .cs
/reload-plugins
```

(Or `/plugin marketplace add /absolute/path/to/a/local/clone`.)

The first C# query after enabling triggers a one-time server download and then a
one-time solution load (tens of seconds on a large solution); after that it's
cached and incremental.

## Configuration

| Env var | Purpose |
| --- | --- |
| `ROSLYN_LSP_DLL` | Absolute path to a `Microsoft.CodeAnalysis.LanguageServer.dll`. Skips the download (offline / custom builds). |
| `ROSLYN_LSP_VERSION` | Pin a different server version from the feed (default: a known-good pinned version). |
| `ROSLYN_FEED_INDEX` | Override the NuGet v3 feed index URL. |
| `ROSLYN_FEED_BASE` | Override the resolved package base address (skips the index lookup). |
| `DOTNET_PATH` | Path to the `dotnet` executable (default: `dotnet` on `PATH`). |

## Test

A self-contained integration test downloads/uses the server, drives the proxy
against a two-project fixture (`App` → `Lib`), and asserts cross-project semantics
resolve:

```
python test/run-test.py
```

Prints `PASS`/`FAIL` and exits non-zero on failure. Needs `node` and `dotnet`.

## Layout

```
.
├── .claude-plugin/marketplace.json     # marketplace listing the plugin + its LSP server
├── plugins/roslyn-csharp/
│   ├── .claude-plugin/plugin.json
│   └── bin/roslyn-lsp-proxy.js         # the proxy (acquisition + solution/open injection)
└── test/
    ├── fixture/                        # minimal App→Lib C# solution
    └── run-test.py                     # integration test
```

## Troubleshooting

- **Empty results / no symbols.** Check `<tmp>/roslyn-lsp-proxy-logs/` and the
  proxy's stderr for `roslyn dll:` and `injecting solution/open:`. No "injecting"
  line means no `.sln`/`.csproj` was found under the client's `rootUri`.
- **Server exits immediately.** You likely lack the .NET runtime the pinned build
  targets (currently .NET 10). Install it, or pin an older `ROSLYN_LSP_VERSION`.
- **`${CLAUDE_PLUGIN_ROOT}` not expanded.** It's documented for plugin MCP servers
  and hooks; if your Claude Code build doesn't expand it for LSP `args`, edit
  `.claude-plugin/marketplace.json` and replace it with the absolute path to
  `plugins/roslyn-csharp`.
- **First run is slow.** It's downloading ~40 MB once. Subsequent runs use the
  cache under your user cache directory.

## Licensing

This project's code (the proxy, manifests, tests) is MIT — see [LICENSE](LICENSE).

It does **not** include or redistribute any Microsoft binary. At runtime it
downloads `Microsoft.CodeAnalysis.LanguageServer` (part of
[dotnet/roslyn](https://github.com/dotnet/roslyn), MIT-licensed) from Microsoft's
public NuGet feed. This project is not affiliated with or endorsed by Microsoft.
"Roslyn", ".NET", and "Visual Studio" are trademarks of Microsoft.

This is not legal advice; review the upstream licenses for your own use.
