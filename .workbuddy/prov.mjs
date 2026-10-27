import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
ws.on("open", () => ws.send(JSON.stringify({ kind: "request", id: "p1", request: { type: "provider.list" } })));
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.kind !== "response" || f.id !== "p1") return;
  for (const p of f.data?.providers ?? []) {
    for (const m of p.models ?? []) console.log(p.id, m.id, m.name, "window:", m.contextWindow);
  }
  process.exit(0);
});
setTimeout(() => process.exit(0), 8000);
