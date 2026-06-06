# claude-roslyn-lsp

A Claude Code plugin that brings full C# code intelligence via **Microsoft's Roslyn language server** (`Microsoft.CodeAnalysis.LanguageServer`) — the same engine powering the VS Code C# extension — instead of the lighter-weight `csharp-ls`.

The plugin ships a small stdio proxy that solves the one thing preventing Roslyn from working under a generic LSP client. The server itself is installed separately as a standard `dotnet` global tool.

## Why Roslyn

Roslyn is the most accurate C# language server and handles file churn (edits, deletes, renames) far better than `csharp-ls` — no stale "predefined type System.Object is not defined" diagnostic storms after bulk changes.

The catch: Roslyn does *not* load a workspace from the standard LSP `initialize`/`rootUri`. It waits for the editor's **proprietary** `solution/open` notification (or `project/open`). A generic LSP client never sends those, so a directly-wired Roslyn server loads zero projects and returns empty results — actually *worse* than `csharp-ls`.

This proxy fixes that by injecting `solution/open` automatically. Measured against the bundled two-project fixture:

| Query | Without `solution/open` | With `solution/open` |
| --- | --- | --- |
| `workspace/symbol "Greeter"` | 0 | 1 |
| `references` (cross-project) | 1 (same file only) | 3 |

## How it works

```
Claude Code ──stdio──▶ roslyn-lsp-proxy.js ──stdio──▶ roslyn-language-server
                              │
                              └─ after the client's `initialized`, injects
                                 `solution/open` for the workspace's .sln
                                 (falls back to `project/open` over .csproj)
```

The proxy forwards all LSP traffic verbatim and injects `solution/open` right after `initialized`. Logs go to stderr and `<tmp>/roslyn-lsp-proxy-logs/` only — never stdout, which is the LSP channel.

## Requirements

- **Node.js** ≥ 18 (the proxy uses only built-ins — no `npm install`).
- **`dotnet`** ≥ 9 on `PATH`, used to install and run the language server.
- The **`roslyn-language-server`** dotnet global tool (see Install below).

## Install

**1. Install the language server**

```sh
dotnet tool install -g roslyn-language-server --prerelease \
  --add-source https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/index.json
```

This installs the same build the VS Code C# extension uses. To update it later:

```sh
dotnet tool update -g roslyn-language-server --prerelease \
  --add-source https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/index.json
```

**2. Install the plugin**

```
/plugin marketplace add danielpivonka/claude-roslyn-lsp
/plugin install roslyn-csharp@claude-roslyn-lsp
/plugin disable csharp-lsp@claude-plugins-official   # avoid two servers on .cs files
/reload-plugins
```

To install from a local clone instead: `/plugin marketplace add /absolute/path/to/clone`

The first C# query triggers a one-time solution load (tens of seconds on a large solution); after that it's incremental.

## Testing

A self-contained integration test drives the proxy against a two-project fixture (`App` → `Lib`) and asserts that cross-project semantics resolve correctly:

```
node test/run-test.js
```

Prints `PASS`/`FAIL` and exits non-zero on failure. Requires `node`, `dotnet`, and `roslyn-language-server` installed as a global tool (see Install above).

## Layout

```
.
├── .claude-plugin/marketplace.json     # marketplace catalog entry
├── plugins/roslyn-csharp/
│   ├── .claude-plugin/plugin.json      # plugin manifest + LSP server declaration
│   └── bin/roslyn-lsp-proxy.js         # the proxy (solution/open injection)
└── test/
    ├── fixture/                        # minimal App→Lib C# solution
    └── run-test.js                     # integration test
```

## Troubleshooting

- **`roslyn-language-server` not found.** The dotnet global tool isn't installed or `~/.dotnet/tools` isn't on your `PATH`. Run the install command from the Install section above, then ensure `~/.dotnet/tools` is in your shell's `PATH`.
- **Empty results / no symbols.** Check `<tmp>/roslyn-lsp-proxy-logs/` and the proxy's stderr for `injecting solution/open:`. If there's no "injecting" line, no `.sln` or `.csproj` was found under the client's `rootUri`.
- **Server exits immediately.** Your .NET runtime may not meet the tool's requirements. Run `dotnet --version` and compare against the installed tool version.
- **`${CLAUDE_PLUGIN_ROOT}` not expanded.** If your Claude Code build doesn't expand it for LSP `args`, edit `plugins/roslyn-csharp/.claude-plugin/plugin.json` and replace it with the absolute path to `plugins/roslyn-csharp`.

## Licensing

MIT — see [LICENSE](LICENSE). The `roslyn-language-server` tool installed separately is part of [dotnet/roslyn](https://github.com/dotnet/roslyn) and is also MIT-licensed.
