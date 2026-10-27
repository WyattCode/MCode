// One voice round trip against the local gateway: precheck, then a real wav.
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
let id = 0;
const pending = new Map();

function rpc(req, ms = 90000) {
  return new Promise((resolve, reject) => {
    const key = "q" + ++id;
    pending.set(key, resolve);
    ws.send(JSON.stringify({ kind: "request", id: key, request: req }));
    setTimeout(() => reject(new Error("timeout " + req.type)), ms);
  });
}

ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.id && pending.has(f.id)) {
    pending.get(f.id)(f);
    pending.delete(f.id);
  }
});

ws.on("open", async () => {
  try {
    const pre = await rpc({ type: "voice.precheck", mode: "fast" });
    console.log("precheck:", JSON.stringify(pre.data ?? pre.error));

    const fs = await import("node:fs");
    const b64 = fs.readFileSync(process.argv[2]).toString("base64");
    const out = await rpc({ type: "voice.transcribe", audio: b64, mime: "audio/wav", mode: "fast", language: "zh-CN" });
    console.log("transcribe:", JSON.stringify(out.data ?? out.error));
  } catch (e) {
    console.error("ERR", e.message);
  }
  process.exit(0);
});