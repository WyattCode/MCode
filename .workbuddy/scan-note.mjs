import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
const waiting = new Map();
const send = (id, request) => new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ kind: "request", id, request })); });
ws.on("open", async () => {
  const l = await send("l", { type: "session.list" });
  let interactive = 0, recovered = 0;
  for (const s of l.data?.sessions ?? []) {
    const g = await send("g" + s.id, { type: "session.get", sessionID: s.id });
    const msgs = g.data?.messages ?? [];
    msgs.forEach((m, i) => {
      for (const p of m.parts ?? []) {
        if (p.type === "tool" && p.metadata?.interactive === true) {
          interactive++;
          console.log("INTERACTIVE:", s.id, s.title, p.name);
        }
      }
      if (m.role === "assistant" && m.error) {
        const next = msgs[i + 1];
        if (next && next.role === "assistant") {
          recovered++;
          console.log("RECOVERED:", s.id, s.title, "err=", String(m.error).slice(0, 50));
        }
      }
    });
  }
  console.log("interactive:", interactive, "recovered errors:", recovered);
  process.exit(0);
});
ws.on("message", (d) => { const f = JSON.parse(d); if (f.kind === "response" && waiting.has(f.id)) { const r = waiting.get(f.id); waiting.delete(f.id); r(f); } });
setTimeout(() => { console.log("TIMEOUT"); process.exit(0); }, 90000);
