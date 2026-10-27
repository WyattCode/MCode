import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
const waiting = new Map();
const send = (id, request) => new Promise((r) => { waiting.set(id, r); ws.send(JSON.stringify({ kind: "request", id, request })); });
ws.on("open", async () => {
  const made = await send("c", { type: "session.create", directory: "D:/Documents/Claude Code/MCode" });
  const s = made.data?.session ?? made.data;
  console.log("session:", s?.id, "ok:", made.ok, made.error ?? "");
  if (!s?.id) { process.exit(0); }
  const p = await send("p", {
    type: "session.prompt",
    sessionID: s.id,
    text: "请调用 bash 工具执行命令 `echo hi`，并在参数里显式传 interactive: true。只做这一次调用，不要重试。",
  });
  console.log("prompt sent:", p.ok, p.error ?? "");
  process.exit(0);
});
ws.on("message", (d) => { const f = JSON.parse(d); if (f.kind === "response" && waiting.has(f.id)) { const r = waiting.get(f.id); waiting.delete(f.id); r(f); } });
setTimeout(() => process.exit(0), 30000);
