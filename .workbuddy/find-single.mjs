import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
const waiting = new Map();
const send = (id, request) => new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ kind: "request", id, request })); });
ws.on("open", async () => {
  const l = await send("l", { type: "session.list" });
  for (const s of l.data?.sessions ?? []) {
    const g = await send("g" + s.id, { type: "session.get", sessionID: s.id });
    let count = 0;
    for (const m of g.data?.messages ?? []) {
      for (const p of m.parts ?? []) {
        if (p.type === "tool" && typeof p.metadata?.diff === "string" && p.metadata.diff) count++;
      }
    }
    if (count >= 1 && count <= 3) console.log(s.id, "|", JSON.stringify(s.title||""), "| diffs=" + count);
  }
  process.exit(0);
});
ws.on("message", (d) => { const f = JSON.parse(d); if (f.kind === "response" && waiting.has(f.id)) { const r = waiting.get(f.id); waiting.delete(f.id); r(f); } });
setTimeout(() => process.exit(0), 60000);
