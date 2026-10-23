import { renderOffice } from "../out/office-html.mjs";
const r = await renderOffice("D:/Apps/MCode/test.docx");
console.log("kind:", r.kind, "| error:", r.error ?? "none");
const body = r.html.replace(/^[\s\S]*<body>/, "").replace(/<\/body>[\s\S]*$/, "");
console.log("--- body ---");
console.log(body);
