import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
const waiting = new Map();
const send = (id, request) => new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ kind: "request", id, request })); });
ws.on("open", async () => {
  const g = await send("g", { type: "session.get", sessionID: "ses_01a1505e372a0000bd3e078ec9a9" });
  const ids = [];
  for (const m of g.data?.messages ?? []) {
    if (m.role !== "assistant") continue;
    const has = (m.parts ?? []).some((p) => p.type === "tool" && p.metadata?.diff);
    if (has) ids.push(m.id);
  }
  console.log("turn messages:", ids);
  const r = await send("r", { type: "session.revertTurn", sessionID: "ses_01a1505e372a0000bd3e078ec9a9", messageIDs: ids });
  console.log("ok:", r.ok, "| error:", r.error ?? "-", "| data:", JSON.stringify(r.data));
  process.exit(0);
});
ws.on("message", (d) => { const f = JSON.parse(d); if (f.kind === "response" && waiting.has(f.id)) { const r = waiting.get(f.id); waiting.delete(f.id); r(f); } });
setTimeout(() => { console.log("TIMEOUT"); process.exit(0); }, 30000);
