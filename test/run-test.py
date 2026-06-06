#!/usr/bin/env python3
"""
Integration test for the roslyn-lsp-proxy.

Drives the proxy with a STANDARD LSP handshake only (no manual solution/open)
against the two-project fixture (App -> Lib), then asserts the proxy made
Roslyn load the workspace and resolve cross-project semantics:

  * workspace/projectInitializationComplete is received
  * workspace/symbol "Greeter" returns >= 1
  * textDocument/references on the Greeter class returns >= 2
    (declaration in Lib + usage in App = cross-project)

Exit code 0 on PASS, 1 on FAIL. Requires: node, dotnet, and an installed
VS Code C# extension (or ROSLYN_LSP_DLL).
"""
import json, os, queue, subprocess, sys, threading, time, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROXY = ROOT / "plugins" / "roslyn-csharp" / "bin" / "roslyn-lsp-proxy.js"
FIXTURE = ROOT / "test" / "fixture"
GREETER = FIXTURE / "src" / "Lib" / "Greeter.cs"

incoming = queue.Queue()
proc = None
_id = [0]


def reader(stdout):
    while True:
        header = b""
        while b"\r\n\r\n" not in header:
            c = stdout.read(1)
            if not c:
                incoming.put(None); return
            header += c
        length = 0
        for line in header.split(b"\r\n"):
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":")[1].strip())
        body = b""
        while len(body) < length:
            c = stdout.read(length - len(body))
            if not c:
                incoming.put(None); return
            body += c
        try:
            incoming.put(json.loads(body.decode("utf-8")))
        except Exception:
            pass


def send(msg):
    data = json.dumps(msg).encode("utf-8")
    proc.stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode() + data)
    proc.stdin.flush()


def uri(p): return pathlib.Path(p).as_uri()
def nid():
    _id[0] += 1; return _id[0]


def pump(pred, timeout):
    end = time.time() + timeout
    while time.time() < end:
        try:
            msg = incoming.get(timeout=0.2)
        except queue.Empty:
            continue
        if msg is None:
            return None
        if "id" in msg and "method" in msg:  # server->client request
            items = msg.get("params", {}).get("items", [])
            res = [None] * len(items) if msg["method"] == "workspace/configuration" else None
            send({"jsonrpc": "2.0", "id": msg["id"], "result": res})
            continue
        if pred(msg):
            return msg
    return None


def req(method, params, timeout=30):
    rid = nid()
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    return pump(lambda m: m.get("id") == rid and "method" not in m, timeout)


def notify(method, params): send({"jsonrpc": "2.0", "method": method, "params": params})


def main():
    global proc
    if not PROXY.exists():
        print(f"FAIL: proxy not found at {PROXY}"); return 1
    proc = subprocess.Popen(["node", str(PROXY)], cwd=str(FIXTURE),
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=None, bufsize=0)
    threading.Thread(target=reader, args=(proc.stdout,), daemon=True).start()

    init = req("initialize", {
        "processId": os.getpid(), "rootUri": uri(FIXTURE),
        "workspaceFolders": [{"uri": uri(FIXTURE), "name": "fixture"}],
        "capabilities": {"workspace": {"configuration": True, "workspaceFolders": True}},
    }, timeout=60)
    if not (init and "result" in init):
        print("FAIL: no initialize response"); proc.terminate(); return 1
    notify("initialized", {})
    notify("textDocument/didOpen", {"textDocument": {
        "uri": uri(GREETER), "languageId": "csharp", "version": 1,
        "text": GREETER.read_text(encoding="utf-8")}})

    init_done = pump(lambda m: m.get("method") == "workspace/projectInitializationComplete", 180)
    time.sleep(2)

    ws = req("workspace/symbol", {"query": "Greeter"}, 30)
    n_ws = len(ws.get("result") or []) if ws else 0
    refs = req("textDocument/references", {
        "textDocument": {"uri": uri(GREETER)},
        "position": {"line": 2, "character": 13},  # 'Greeter' in 'public class Greeter'
        "context": {"includeDeclaration": True}}, 30)
    n_refs = len(refs.get("result") or []) if refs else 0
    proc.terminate()

    ok_init = init_done is not None
    ok_ws = n_ws >= 1
    ok_refs = n_refs >= 2
    print(f"  projectInitializationComplete : {'ok' if ok_init else 'MISSING'}")
    print(f"  workspace/symbol 'Greeter'    : {n_ws} (need >=1)")
    print(f"  references (cross-project)     : {n_refs} (need >=2)")
    if ok_init and ok_ws and ok_refs:
        print("PASS"); return 0
    print("FAIL"); return 1


if __name__ == "__main__":
    sys.exit(main())
