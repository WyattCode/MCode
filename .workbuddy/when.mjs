import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
const waiting = new Map();
const send = (id, request) => new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ kind: "request", id, request })); });
ws.on("open", async () => {
  const g = await send("g", { type: "session.get", sessionID: "ses_01a1505e372a0000bd3e078ec9a9" });
  const msgs = g.data?.messages ?? [];
  console.log("messages:", msgs.length);
  msgs.forEach((m, i) => {
    const tools = (m.parts ?? []).filter((p) => p.type === "tool").map((p) => p.name + (p.metadata?.diff ? "*" : ""));
    const text = (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text.slice(0, 40)).join(" / ");
    console.log(i, m.role, "| tools:", tools.join(","), "| ", text.replace(/\n/g, " ").slice(0, 70));
  });
  process.exit(0);
});
ws.on("message", (d) => { const f = JSON.parse(d); if (f.kind === "response" && waiting.has(f.id)) { const r = waiting.get(f.id); waiting.delete(f.id); r(f); } });
setTimeout(() => process.exit(0), 20000);
