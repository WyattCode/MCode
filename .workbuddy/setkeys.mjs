import WebSocket from "ws";

const keys = {
  qwen: "OHoX71VLS1YCtV8ln714aMNkiIrz6bGU",
  glm: "sk-local-f02ce7522e16d7cea59cdda242a47d5589da080417d20210dc5a243080d996f0",
  ds: "sk-dspark-4bb4f2c57bf04f1ebd6c9af9d6405e8426dd232503c4925876a64c501cb3eac9",
};

const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
let id = 0;
const pending = new Map();
function rpc(req, ms = 30000) {
  return new Promise((res, rej) => {
    const i = "k" + ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ kind: "request", id: i, request: req }));
    setTimeout(() => rej(new Error("timeout " + i)), ms);
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
  for (const [provider, apiKey] of Object.entries(keys)) {
    try {
      const out = await rpc({ type: "provider.auth", provider, apiKey });
      console.log(provider, "->", out.ok ? "ok models=" + (out.data?.models ?? "?") : "FAILED " + (out.error ?? ""));
    } catch (e) {
      console.log(provider, "->", e.message);
    }
  }
  process.exit(0);
});
setTimeout(() => process.exit(0), 90000);