import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
ws.on("open", () => ws.send(JSON.stringify({ kind: "request", id: "g", request: { type: "session.get", sessionID: "ses_01a0dd62fae7000009629e98961e" } })));
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.id !== "g") return;
  for (const m of f.data?.messages ?? []) for (const p of m.parts ?? []) {
    if (p.name === "edit" || p.name === "write") {
      console.log("name:", p.name);
      console.log("input:", JSON.stringify(p.input)?.slice(0, 200));
      console.log("title:", p.title, "| state.output len:", (p.state?.output ?? "").length);
      process.exit(0);
    }
  }
  process.exit(0);
});
setTimeout(() => process.exit(0), 8000);
