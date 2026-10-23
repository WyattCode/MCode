import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
let list = [];
let idx = 0;
const waiting = new Map();
let totals = { tools: 0, diff: 0, filediff: 0 };
let best = null;
function send(id, request) {
  return new Promise((res) => { waiting.set(id, res); ws.send(JSON.stringify({ kind: "request", id, request })); });
}
ws.on("open", async () => {
  const l = await send("l", { type: "session.list" });
  list = l.data?.sessions ?? [];
  for (const s of list) {
    const g = await send("g" + s.id, { type: "session.get", sessionID: s.id });
    let tools = 0, diff = 0, filediff = 0;
    for (const m of g.data?.messages ?? []) {
      for (const p of m.parts ?? []) {
        if (p.type !== "tool") continue;
        tools++;
        if (typeof p.metadata?.diff === "string" && p.metadata.diff) diff++;
        if (p.metadata?.filediff) filediff++;
      }
    }
    totals.tools += tools; totals.diff += diff; totals.filediff += filediff;
    if (tools) console.log(s.id, JSON.stringify(s.title||""), "tools=" + tools, "diff=" + diff, "filediff=" + filediff);
    if (diff > 0 && (!best || diff > best.diff)) best = { id: s.id, title: s.title, diff, sample: g };
  }
  console.log("TOTALS", JSON.stringify(totals));
  if (best) {
    console.log("=== sample from", best.id, best.title);
    for (const m of best.sample.data?.messages ?? []) {
      for (const p of m.parts ?? []) {
        if (p.type === "tool" && typeof p.metadata?.diff === "string" && p.metadata.diff) {
          console.log("name=", p.name, "title=", p.title);
          console.log("metadata keys=", Object.keys(p.metadata).join(","));
          console.log(p.metadata.diff.slice(0, 300));
          process.exit(0);
        }
      }
    }
  }
  process.exit(0);
});
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.kind === "response" && waiting.has(f.id)) { const r = waiting.get(f.id); waiting.delete(f.id); r(f); }
});
setTimeout(() => { console.log("TIMEOUT", JSON.stringify(totals)); process.exit(0); }, 60000);