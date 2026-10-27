// Find a stored session whose messages contain a real markdown table.
//
// The one surface still untested on the device is a table's cells, and creating
// a reply with one would spend a model call. The transcript's own history is
// already on disk, so the table is looked for there instead.
import fs from "node:fs";
import path from "node:path";

const root = "C:/Users/Wyatt/AppData/Roaming/mcode/storage/session";

function files(dir, out = []) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of names) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

const all = files(root);
const hits = [];
for (const p of all) {
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
  // A table needs a header row, a separator row of dashes, and a body row.
  const m = text.match(/\|[^\n|]{1,80}\|[^\n]{0,120}\\n\|[\s:|-]{3,}\|/);
  if (m) hits.push({ p, len: text.length, sample: m[0].slice(0, 160) });
}
hits.sort((a, b) => b.len - a.len);
console.log("scanned", all.length, "files;", hits.length, "with a table");
for (const h of hits.slice(0, 6)) {
  console.log("\n" + h.p);
  console.log("   " + h.sample.replace(/\\n/g, " / "));
}
