import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
ws.on("open", () => ws.send(JSON.stringify({ kind: "request", id: "s1", request: { type: "search.messages", query: "sleep", limit: 5 } })));
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.kind !== "response" || f.id !== "s1") return;
  console.log(JSON.stringify(f).slice(0, 900));
  process.exit(0);
});
setTimeout(() => process.exit(0), 8000);
