import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
const waiting = new Map();
const send = (id, request) => new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ kind: "request", id, request })); });
ws.on("open", async () => {
  const l = await send("l", { type: "session.list" });
  let total = 0, withFiles = 0, sample = null;
  for (const s of l.data?.sessions ?? []) {
    const g = await send("g" + s.id, { type: "session.get", sessionID: s.id });
    for (const m of g.data?.messages ?? []) {
      for (const p of m.parts ?? []) {
        if (p.type !== "tool" || p.name !== "present_files") continue;
        total++;
        const files = p.metadata?.files;
        if (Array.isArray(files) && files.length) {
          withFiles++;
          if (!sample) sample = { s: s.id, p };
        }
      }
    }
  }
  console.log("present_files calls:", total, "with files:", withFiles);
  if (sample) {
    console.log("metadata keys:", Object.keys(sample.p.metadata));
    console.log("files[0]:", JSON.stringify(sample.p.metadata.files[0]));
    console.log("status:", sample.p.status);
  }
  process.exit(0);
});
ws.on("message", (d) => { const f = JSON.parse(d); if (f.kind === "response" && waiting.has(f.id)) { const r = waiting.get(f.id); waiting.delete(f.id); r(f); } });
setTimeout(() => { console.log("TIMEOUT"); process.exit(0); }, 60000);
