import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
ws.on("open", () => {
  ws.send(JSON.stringify({
    kind: "request", id: "r1",
    request: { type: "session.revertTurn", sessionID: "ses_01a0dd62fae7000009629e98961e", messageIDs: ["msg_does_not_exist"] },
  }));
});
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.kind !== "response") return;
  console.log("ok:", f.ok, "| error:", f.error ?? "(none)");
  console.log("data:", JSON.stringify(f.data));
  process.exit(0);
});
setTimeout(() => { console.log("TIMEOUT"); process.exit(0); }, 15000);