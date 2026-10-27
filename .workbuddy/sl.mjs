import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
ws.on("open", () => ws.send(JSON.stringify({ kind: "request", id: "l1", request: { type: "session.list" } })));
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.kind !== "response" || f.id !== "l1") return;
  const s = f.data?.sessions ?? [];
  console.log("count:", s.length);
  for (const x of s.slice(0, 6)) console.log(x.id, JSON.stringify(x.title), x.directory);
  process.exit(0);
});
setTimeout(() => process.exit(0), 8000);
