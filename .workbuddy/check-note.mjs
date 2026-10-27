import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
const waiting = new Map();
const send = (id, request) => new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ kind: "request", id, request })); });
ws.on("open", async () => {
  const g = await send("g", { type: "session.get", sessionID: "ses_01a15e3b5d4900002debae158f18" });
  for (const m of g.data?.messages ?? []) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool") continue;
      const md = p.metadata ?? {};
      console.log(p.name, "| status:", p.status, "| interactive:", md.interactive, "| exit:", md.exit);
    }
  }
  process.exit(0);
});
ws.on("message", (d) => { const f = JSON.parse(d); if (f.kind === "response" && waiting.has(f.id)) { const r = waiting.get(f.id); waiting.delete(f.id); r(f); } });
setTimeout(() => process.exit(0), 20000);
