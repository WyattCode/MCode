import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
ws.on("open", () => ws.send(JSON.stringify({ kind: "request", id: "v1", request: { type: "file.read", root: "D:/Apps", rel: "video-test.mp4", preview: true } })));
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.kind !== "response" || f.id !== "v1") return;
  const r = f.data ?? {};
  console.log("video:", r.video, "kind:", r.kind, "mime:", r.mime, "data bytes(b64):", (r.data ?? "").length, "tooBig:", r.tooBig);
  process.exit(0);
});
setTimeout(() => process.exit(0), 8000);
