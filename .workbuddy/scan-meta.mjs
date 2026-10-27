import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:7900", ["mcode", "mcode.remote.mcode-fold-2026"]);
let sid = process.argv[2];
ws.on("open", () => {
  if (!sid) ws.send(JSON.stringify({ kind: "request", id: "l", request: { type: "session.list" } }));
  else ws.send(JSON.stringify({ kind: "request", id: "g", request: { type: "session.get", sessionID: sid } }));
});
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.kind !== "response") return;
  if (f.id === "l") {
    const rows = f.data?.sessions ?? [];
    console.log("sessions:", rows.length);
    for (const s of rows.slice(0, 12)) console.log(" ", s.id, JSON.stringify(s.title || "").slice(0, 60));
    process.exit(0);
  }
  const msgs = f.data?.messages ?? [];
  let tools = 0, withDiff = 0, names = {};
  for (const m of msgs) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool") continue;
      tools++;
      names[p.name] = (names[p.name] || 0) + 1;
      if (p.metadata && typeof p.metadata.diff === "string" && p.metadata.diff) {
        withDiff++;
        if (withDiff <= 2) {
          console.log("--- has diff:", p.name, "len", p.metadata.diff.length);
          console.log(p.metadata.diff.slice(0, 400));
        }
      }
      if (p.metadata && p.metadata.filediff) {
        console.log("--- has filediff:", p.name, JSON.stringify(Object.keys(p.metadata.filediff)));
      }
    }
  }
  console.log("tools:", tools, "withDiff:", withDiff, "names:", JSON.stringify(names));
  process.exit(0);
});
setTimeout(() => process.exit(0), 15000);