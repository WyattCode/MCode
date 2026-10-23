import { renderOffice } from "../out/office-html.mjs";
for (const f of ["test.xlsx", "test.pptx"]) {
  const r = await renderOffice(`D:/Apps/MCode/${f}`);
  const body = r.html.replace(/^[\s\S]*<body>/, "").replace(/<\/body>[\s\S]*$/, "");
  console.log(`=== ${f} (${r.kind}) error=${r.error ?? "none"}`);
  console.log(body.slice(0, 420));
}
