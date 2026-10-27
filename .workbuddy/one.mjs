import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
const waiting = new Map();
const send = (id, request) => new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ kind: "request", id, request })); });
ws.on("open", async () => {
  const g = await send("g", { type: "session.get", sessionID: "ses_01a1505e372a0000bd3e078ec9a9" });
  for (const m of g.data?.messages ?? []) {
    for (const p of m.parts ?? []) {
      if (p.type === "tool" && typeof p.metadata?.diff === "string" && p.metadata.diff) {
        console.log("name:", p.name, "| title:", p.title, "| created:", p.metadata.created);
        console.log("input:", JSON.stringify(p.input).slice(0, 200));
        console.log(p.metadata.diff.slice(0, 300));
      }
    }
  }
  process.exit(0);
});
ws.on("message", (d) => { const f = JSON.parse(d); if (f.kind === "response" && waiting.has(f.id)) { const r = waiting.get(f.id); waiting.delete(f.id); r(f); } });
setTimeout(() => process.exit(0), 20000);
