import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
ws.on("open", () => ws.send(JSON.stringify({ kind: "request", id: "g1", request: { type: "session.get", sessionID: process.argv[2] } })));
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.kind === "response") { console.log(JSON.stringify(f.data?.messages?.slice(-2), null, 1).slice(0, 2500)); process.exit(0); }
});
setTimeout(() => process.exit(0), 10000);
