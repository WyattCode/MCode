import WebSocket from "ws";

// Watches the gateway the way the phone does: declares one conversation, then
// reports every event it receives for it.
const sid = process.argv[2];
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
let n = 0;
ws.on("open", () => {
  console.log("open");
  ws.send(JSON.stringify({ kind: "request", id: "w", request: { type: "session.watch", sessionIDs: [sid] } }));
  ws.send(JSON.stringify({ kind: "request", id: "l", request: { type: "session.list" } }));
});
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.kind === "remote.event") {
    const e = f.event;
    if (e.sessionID === sid || e.session?.id === sid) {
      n++;
      console.log("event", e.type, "|", e.eventId ?? "");
    }
  }
});
setTimeout(() => {
  console.log("events seen:", n);
  process.exit(0);
}, 60000);