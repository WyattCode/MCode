import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
const waiting = new Map();
function send(id, request) { return new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ kind: "request", id, request })); }); }
ws.on("open", async () => {
  const g = await send("g", { type: "session.get", sessionID: "ses_01a0fd521dfa000057d129c46850" });
  let shown = 0;
  for (const m of g.data?.messages ?? []) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool") continue;
      if (!(typeof p.metadata?.diff === "string" && p.metadata.diff)) continue;
      if (shown++ > 0) continue;
      console.log("part keys:", Object.keys(p).join(","));
      console.log("has state:", Boolean(p.state), "state keys:", p.state ? Object.keys(p.state).join(",") : "-");
      console.log("state.metadata:", p.state?.metadata ? Object.keys(p.state.metadata).join(",") : "-");
      console.log("top metadata:", Object.keys(p.metadata).join(","));
      console.log("status top:", p.status, "| state.status:", p.state?.status);
      console.log("created:", p.metadata.created);
      process.exit(0);
    }
  }
  console.log("none found");
  process.exit(0);
});
ws.on("message", (d) => { const f = JSON.parse(d); if (f.kind === "response" && waiting.has(f.id)) { const r = waiting.get(f.id); waiting.delete(f.id); r(f); } });
setTimeout(() => { console.log("TIMEOUT"); process.exit(0); }, 20000);