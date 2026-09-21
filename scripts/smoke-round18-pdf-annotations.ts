/**
 * The PDF view's full annotation layer (HANDOFF R17-V, left undone).
 *
 * MiMo 26.920 renders react-pdf's <Page> with its defaults: pdf.js's
 * AnnotationLayer over each page (links, highlight and note popups), forms
 * painted on the canvas (renderForms false), outbound links taken in the
 * capture phase and handed to openExternalUrl for http, https, mailto and tel.
 * Until now MCode laid only bare anchors for URL links: no notes, no popups, no
 * link into the document. Geometry at two zooms, the clicks and the popup are
 * measured in a real window by the pdfann probe; here the link rules run for
 * real, pdf.js itself reads a generated PDF, and the wiring is read.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { PdfLinkService, destinationTop, namedActionPage, pdfLinkAction, resolveDestination } from "../src/renderer/src/lib/pdf-links"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/* A two-page PDF: an internal link to page 2 at y 420, a web link, a note and a highlight on page 1. */
function annotatedPdf(): Uint8Array {
  const stream = (text: string) => `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R /Annots [8 0 R 9 0 R 10 0 R 11 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    stream("BT /F1 12 Tf 72 700 Td (Go to page two) Tj ET"),
    stream("BT /F1 12 Tf 72 400 Td (Target) Tj ET"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Annot /Subtype /Link /Rect [70 695 220 713] /Border [0 0 0] /Dest [4 0 R /XYZ 0 420 null] >>",
    "<< /Type /Annot /Subtype /Link /Rect [70 665 200 683] /Border [0 0 0] /A << /S /URI /URI (https://example.com/pdf-test) >> >>",
    "<< /Type /Annot /Subtype /Text /Rect [400 605 420 625] /Name /Comment /Contents (A sticky note) /T (Tester) >>",
    "<< /Type /Annot /Subtype /Highlight /Rect [70 636 290 654] /QuadPoints [70 654 290 654 70 636 290 636] /C [1 1 0] /Contents (Highlight comment) >>",
  ]
  let out = "%PDF-1.7\n"
  const offsets: number[] = []
  objects.forEach((body, at) => {
    offsets.push(out.length)
    out += `${at + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, "latin1"))
}

export async function roundEighteenPdfAnnotationChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 18: the PDF view's link rules and link service, run")
  {
    check("a destination or named action (bound as #) stays in the document", pdfLinkAction("#") === "internal")
    check("the web, mail and phone go out, as MiMo's", ["https://a.b", "http://a.b", "mailto:x@y", "tel:1", "HTTPS://A.B"].every((href) => pdfLinkAction(href) === "external"))
    check("anything else is blocked", ["javascript:alert(1)", "file:///C:/x", "ftp://a", "mcode-media://x", ""].every((href) => pdfLinkAction(href) === "blocked"))

    const ref = { num: 4, gen: 0 }
    check("XYZ keeps its left and top", JSON.stringify(destinationTop([ref, { name: "XYZ" }, 10, 420, null])) === JSON.stringify({ left: 10, top: 420 }))
    check("FitH and FitBH keep their top", destinationTop([ref, { name: "FitH" }, 300]).top === 300 && destinationTop([ref, { name: "FitBH" }, 12]).top === 12)
    check("FitR's top is its fourth number", destinationTop([ref, { name: "FitR" }, 1, 2, 3, 4]).top === 4)
    check("Fit and a missing top mean the page's top", destinationTop([ref, { name: "Fit" }]).top === null && destinationTop([ref, { name: "XYZ" }, null, null, null]).top === null)

    const fake = {
      numPages: 3,
      getDestination: async (id: string) => (id === "chap2" ? [ref, { name: "XYZ" }, 0, 500, null] : null),
      getPageIndex: async (r: { num: number }) => {
        if (r.num === 4) return 1
        throw new Error("no such page")
      },
    }
    const named = await resolveDestination(fake, "chap2")
    check("a named destination resolves to its page and point", named?.pageIndex === 1 && named?.top === 500, named)
    check("an unknown name leads nowhere", (await resolveDestination(fake, "nope")) === null)
    check("an integer page reference is a page index", (await resolveDestination(fake, [2, { name: "Fit" }]))?.pageIndex === 2)
    check("a page past the end leads nowhere", (await resolveDestination(fake, [3, { name: "Fit" }])) === null)
    check("a reference pdf.js cannot place leads nowhere", (await resolveDestination(fake, [{ num: 99, gen: 0 }, { name: "Fit" }])) === null)

    check("named actions move by page, clamped", namedActionPage("NextPage", 3, 3) === 3 && namedActionPage("PrevPage", 1, 3) === 1 && namedActionPage("FirstPage", 2, 3) === 1 && namedActionPage("LastPage", 1, 3) === 3)
    check("other named actions are not about pages", namedActionPage("Print", 1, 3) === null && namedActionPage("GoBack", 1, 3) === null)

    const gone: unknown[] = []
    const actions: string[] = []
    const service = new PdfLinkService({ goTo: (dest) => gone.push(dest), named: (action) => actions.push(action) })
    const link = { href: "", rel: "", target: "_blank" }
    service.addLinkAttributes(link, "https://example.com", true)
    check("an outbound anchor gets its URL, no referrer, and never a new window", link.href === "https://example.com" && link.rel === "noopener noreferrer nofollow" && link.target === "", link)
    check("destinations and actions are bound as #, which the view lets through", service.getDestinationHash([ref]) === "#" && service.getAnchorUrl("") === "#")
    service.goToDestination("chap2")
    service.executeNamedAction("NextPage")
    check("the service hands destinations and named actions to the view", gone[0] === "chap2" && actions[0] === "NextPage")
    check("no sandbox bus: pdf.js's optional chaining finds nothing to dispatch to", service.eventBus === undefined)
  }

  section("Round 18: pdf.js reads the annotations the layer is built from")
  {
    const lib = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const pdf = await lib.getDocument({ data: annotatedPdf(), isEvalSupported: false, verbosity: 0 }).promise
    const page = await pdf.getPage(1)
    const annotations = (await page.getAnnotations({ intent: "display" })) as { subtype: string; url?: string; dest?: unknown; rect: number[] }[]
    const kinds = annotations.map((item) => item.subtype).join(",")
    check("the four annotations are there to render", kinds === "Link,Link,Text,Highlight", kinds)
    const internal = annotations.find((item) => item.subtype === "Link" && item.dest)
    const target = internal ? await resolveDestination(pdf as never, internal.dest) : null
    check("the internal link resolves, through the real document, to page 2 at 420pt", target?.pageIndex === 1 && target?.top === 420, target)
    const external = annotations.find((item) => item.subtype === "Link" && item.url)
    check("the web link's URL is one the view sends out", external?.url !== undefined && pdfLinkAction(external.url) === "external", external?.url)
    await pdf.destroy()
  }

  section("Round 18: the PDF view builds pdf.js's annotation layer as MiMo's react-pdf does")
  {
    const view = await read("src/renderer/src/components/right/PdfView.vue")
    const script = view.slice(0, view.indexOf("<template>"))
    check("each drawn page gets pdf.js's AnnotationLayer, not hand-made anchors", /new lib\.AnnotationLayer\(\{/.test(script) && !/document\.createElement\("a"\)/.test(script))
    check("forms stay on the canvas, as MiMo's renderForms false", /renderForms: false/.test(script))
    check("the layer's viewport is unflipped, as react-pdf passes it", /viewport\.clone\(\{ dontFlip: true \}\)/.test(script))
    check("note icons come from pdf.js's images beside the page", /imageResourcesPath: assets\("images"\)/.test(script))
    check("the service is the one in lib/pdf-links", /linkService = new PdfLinkService\(/.test(script))
    const handler = script.slice(script.indexOf("function onLinkClick"), script.indexOf("async function goToDestination"))
    check(
      "the capture handler lets # links reach pdf.js before it stops anything",
      /if \(action === "internal"\) return/.test(handler) && handler.indexOf('action === "internal"') < handler.indexOf("stopPropagation"),
      handler.slice(0, 400),
    )
    check("outbound links still leave only through window.mcode.openExternal", /if \(action === "external"\) window\.mcode\.openExternal\(href\)/.test(handler))
    check("a destination is brought to the view top through the view's own scroll", /scrollToTop\(el, Math\.max\(0, Math\.round\(top \+ offset\)\)\)/.test(script))

    const style = view.slice(view.lastIndexOf("<style>"))
    for (const rule of [
      ".pdf-view .annotationLayer section {",
      ".pdf-view .textLayer.selecting ~ .annotationLayer section {",
      ".pdf-view .annotationLayer .textAnnotation img {",
      ".pdf-view .annotationLayer .popupAnnotation {",
      ".pdf-view .annotationLayer .popup {",
      ".pdf-view .annotationLayer .popupContent {",
    ])
      check(`pdf.js's rule is there: ${rule}`, style.includes(rule))
    check("the layer's rules name no new custom properties", !/--[a-z-]+\s*:/.test(style.slice(style.indexOf(".pdf-view .annotationLayer {"))))

    const config = await read("electron.vite.config.ts")
    check("the build copies the annotation icons to pdfjs/images", /PDFJS_ICON = \/\^annotation-\[a-z\]\+\\\.svg\$\//.test(config) && /resolve\(outDir, "pdfjs", "images", name\)/.test(config))
    const icons = (await fs.readdir(path.join(process.cwd(), "node_modules/pdfjs-dist/web/images"))).filter((name) => /^annotation-[a-z]+\.svg$/.test(name))
    check("pdfjs-dist ships the note icons the layer asks for", ["note", "comment", "help", "key", "paperclip"].every((name) => icons.includes(`annotation-${name}.svg`)), icons)
  }
}
