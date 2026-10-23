import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
let ids = [], done = 0;
ws.on("open", () => ws.send(JSON.stringify({ kind: "request", id: "l", request: { type: "session.list" } })));
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.id === "l") { ids = f.data.sessions.map((s) => s.id); for (const id of ids) ws.send(JSON.stringify({ kind: "request", id: "g" + id, request: { type: "session.get", sessionID: id } })); return; }
  if (!String(f.id).startsWith("g")) return;
  for (const m of f.data?.messages ?? []) for (const p of m.parts ?? []) {
    if (["edit","write","patch","apply_patch"].includes(p.name)) {
      const ip = p.input?.path ?? p.input?.filePath ?? "";
      console.log("EDIT", f.id.slice(1,12), p.name, p.status, "path:", ip.slice(0,50));
      break;
    }
  }
  if (++done === ids.length) process.exit(0);
});
setTimeout(() => process.exit(0), 20000);
