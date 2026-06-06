# claude-roslyn-lsp

A Claude Code plugin that gives C# code intelligence through **Microsoft's Roslyn
language server** (`Microsoft.CodeAnalysis.LanguageServer` — the same engine the
VS Code C# extension uses), instead of the lighter-weight `csharp-ls`.

It ships a tiny stdio proxy that solves the one thing that otherwise stops Roslyn
from working under a generic LSP client.

## Why

Roslyn is the most accurate C# language server and handles file churn (edits,
deletes, renames) far better than `csharp-ls` — no stale "predefined type
System.Object is not defined" diagnostic storms after bulk changes.

**But** Roslyn does *not* load a workspace from the standard LSP
`initialize`/`rootUri`. It waits for the editor's **proprietary** `solution/open`
notification (or `project/open`). A generic LSP client never sends those, so a
directly-wired Roslyn server loads zero projects and returns empty results —
actually *worse* than `csharp-ls`.

Measured against a 2-project fixture (no `solution/open` vs. with it):

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

The proxy:
- **auto-discovers** the Roslyn binary from the newest installed
  `ms-dotnettools.csharp-*` extension (override with `ROSLYN_LSP_DLL`);
- launches it (`dotnet <dll> --stdio …`);
- forwards every byte in both directions **verbatim**;
- derives the workspace `.sln` from the client's `initialize` `rootUri` and
  injects `solution/open` right after `initialized`;
- logs only to stderr / `%TEMP%/roslyn-lsp-proxy-logs` (never stdout).

## Requirements

- **Node.js** ≥ 18 (the proxy uses only built-ins).
- **`dotnet`** on `PATH` (override with `DOTNET_PATH`), with a runtime matching the
  Roslyn build's target framework (currently `net10.0`).
- The **Roslyn binary**, provided by the VS Code C# extension
  (`ms-dotnettools.csharp`). If you don't use VS Code, point `ROSLYN_LSP_DLL` at a
  `Microsoft.CodeAnalysis.LanguageServer.dll` from any source.

## Install (Claude Code)

From a local clone:

```
/plugin marketplace add /absolute/path/to/claude-roslyn-lsp
/plugin install roslyn-csharp@claude-roslyn-lsp
/plugin disable csharp-lsp@claude-plugins-official   # avoid two servers on .cs
/reload-plugins
```

Or straight from GitHub:

```
/plugin marketplace add <your-github-username>/claude-roslyn-lsp
/plugin install roslyn-csharp@claude-roslyn-lsp
/plugin disable csharp-lsp@claude-plugins-official
/reload-plugins
```

The first query after a restart triggers a one-time solution load (it can take
tens of seconds on a large solution); after that it's incremental.

## Configuration

| Env var | Purpose |
| --- | --- |
| `ROSLYN_LSP_DLL` | Absolute path to `Microsoft.CodeAnalysis.LanguageServer.dll`. Skips auto-discovery. |
| `DOTNET_PATH` | Path to the `dotnet` executable (default: `dotnet` on `PATH`). |

## Test

A self-contained integration test drives the proxy against a two-project fixture
(`App` → `Lib`) and asserts cross-project semantics resolve:

```
python test/run-test.py
```

Prints `PASS`/`FAIL` and exits non-zero on failure. Needs `node`, `dotnet`, and a
discoverable Roslyn binary.

## Layout

```
.
├── .claude-plugin/marketplace.json     # marketplace listing the plugin + its LSP server
├── plugins/roslyn-csharp/
│   ├── .claude-plugin/plugin.json
│   └── bin/roslyn-lsp-proxy.js         # the proxy
└── test/
    ├── fixture/                        # minimal App→Lib C# solution
    └── run-test.py                     # integration test
```

## Troubleshooting

- **Empty results / no symbols.** Check `%TEMP%/roslyn-lsp-proxy-logs/` and the
  proxy's stderr for the `roslyn dll:` and `injecting solution/open:` lines. No
  "injecting" line means the workspace `.sln`/`.csproj` wasn't found under the
  client's `rootUri`.
- **`${CLAUDE_PLUGIN_ROOT}` not expanded.** It's documented for plugin MCP servers
  and hooks; if your Claude Code build doesn't expand it for LSP `args`, edit
  `.claude-plugin/marketplace.json` and replace `${CLAUDE_PLUGIN_ROOT}` with the
  absolute path to `plugins/roslyn-csharp`.
- **`dotnet` runtime mismatch.** If the server exits immediately, you likely lack
  the runtime version the Roslyn build targets; install the matching .NET runtime.

## Maintenance

The Roslyn binary lives under a **versioned** path
(`…/ms-dotnettools.csharp-<ver>/.roslyn/…`); the proxy always picks the newest
installed, so C# extension updates need no changes here.

## License

MIT © Daniel Pivonka
