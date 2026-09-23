/**
 * Round 24: the bar across the top of the column goes, and a zoom step stops
 * leaving every measurement in the window behind.
 *
 * The user saw the zoom notice itself - the capsule saying the zoom had
 * changed - standing a tenth of the window right of centre, and asked for the
 * whole class rather than that one notice. Nineteen places measure something
 * and write it down; all nineteen re-took the measurement on `window`'s resize
 * event and on nothing else, and a zoom fires no such event. One of them, the
 * browser tab's page, was wrong in its units as well: the renderer measures in
 * CSS pixels and a native view is placed in the window's own.
 *
 * Measured with an Electron probe on 2026-09-24 (scratchpad `r24`): at 110% the
 * work area's centre was 810 while the notice column carried 878, and a frame
 * the renderer reported as 400 wide had the page drawn 400 of the window's
 * pixels into a 440-pixel hole. Each check below fails on the code round 23
 * left behind.
 *
 * smoke.ts calls `roundTwentyFourChecks` with its own check and section.
 * `root` is the checkout to read, the working directory unless given.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

/** Code without its comments, so a check reads what runs. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** A single-file component split into the three parts a check asks about. */
function parts(source: string): { all: string; template: string; style: string } {
  const template = source.slice(source.indexOf("<template>"), source.lastIndexOf("</template>"))
  const style = source.slice(source.indexOf("<style"), source.lastIndexOf("</style>"))
  return { all: source, template, style }
}

export async function roundTwentyFourChecks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")

  // --------------------------------------------------------------- R24-1
  section("Round 24 (1): nothing is drawn across the top of the conversation while a turn runs")
  {
    const app = parts(await read("src/renderer/src/App.vue"))
    const running = code(app.all)
    check(
      "the sweeping bar is gone from the markup (user decision 2026-09-24)",
      !/class="progress"/.test(app.template) && !/app\.busy.*class="progress"/.test(running),
      app.template.slice(app.template.indexOf("<main"), app.template.indexOf("<main") + 300),
    )
    check("and its rules and its animation went with it", !/^\.progress[ {]/m.test(app.style) && !/@keyframes sweep/.test(app.style))
    check("the turn still says it is running everywhere else it did", /app\.busy/.test(running))
  }

  // --------------------------------------------------------------- R24-2
  section("Round 24 (2): a zoom step reaches the page as the resize it is")
  {
    const follow = code(await read("src/renderer/src/lib/zoom-resize.ts"))
    check("the step is announced as a window resize, straight away", /function announce\(\) \{\s*\n\s*window\.dispatchEvent\(new Event\("resize"\)\)/.test(follow), follow)
    check(
      "from both sources, because a pinch never reaches the backend and the backend's message is the certain one",
      /window\.visualViewport\?\.addEventListener\("resize", announce\)/.test(follow) && /window\.mcode\?\.onZoomChanged\?\.\(announce\)/.test(follow),
      follow,
    )
    check("and again on the next frame, since the page is not always laid out again yet", /requestAnimationFrame\(\(\) => window\.dispatchEvent\(new Event\("resize"\)\)\)/.test(follow))
    check("it hands back the way to stop, and stopping stops both sources and the frame", /removeEventListener\("resize", announce\)/.test(follow) && /unzoom\?\.\(\)/.test(follow) && /cancelAnimationFrame\(again\)/.test(follow))

    const app = code(await read("src/renderer/src/App.vue"))
    check("the window follows the zoom for its whole life, and lets go at the end", /offZoomResize = followZoom\(\)/.test(app) && /offZoomResize\?\.\(\)/.test(app))
  }

  // --------------------------------------------------------------- R24-3
  section("Round 24 (3): the two measurements that needed more than the resize")
  {
    const column = code(await read("src/renderer/src/components/Toasts.vue"))
    /*
     * A notice raised in the same tick as the thing that moved the work area
     * would otherwise be painted once at the old centre. The watcher runs
     * before the DOM is patched, so the first frame is already right.
     */
    check("an arriving notice re-measures before it is painted", /\(count, was\) => \{\s*\n\s*if \(count > \(was \?\? 0\)\) measure\(\)/.test(column), column.slice(column.indexOf("watch("), column.indexOf("watch(") + 200))

    const bar = code(await read("src/renderer/src/components/FindBar.vue"))
    /*
     * The side panel opening beside the pane, the side column folding and the
     * bottom drawer coming up all move the pane without resizing the window,
     * and the bar hung on the window's event alone. Probe: the pane's trailing
     * edge moved 300 and the bar stayed put, 280 out over the panel.
     */
    check("the find bar watches the pane it hangs in, not only the window", /new ResizeObserver\(measure\)/.test(bar) && /watching\.observe\(host\)/.test(bar))
    check("and picks the pane up whenever it appears or is replaced", /host === watched/.test(bar) && /watchPane\(\)\s*\n\s*measure\(\)/.test(bar))
  }

  // --------------------------------------------------------------- R24-4
  section("Round 24 (4): a browser tab's page is placed in the window's pixels")
  {
    const browser = code(await read("src/main/browser.ts"))
    check(
      "the frame the renderer measured is converted by the window's zoom factor",
      /const scale = window\.webContents\.getZoomFactor\(\) \|\| 1/.test(browser) && /x: Math\.round\(bounds\.x \* scale\)/.test(browser) && /width: Math\.max\(0, Math\.round\(bounds\.width \* scale\)\)/.test(browser),
      browser.slice(browser.indexOf("export function setBounds"), browser.indexOf("export function setBounds") + 400),
    )
    check("and read where it is used, so a step the renderer has not heard of cannot misplace the page", !/scale: number/.test(browser) && !/zoomFactor/.test(browser))
    check("a step places the page again from the bounds already held", /export function rescale\(window: BrowserWindow\): void \{[\s\S]*?setBounds\(window, panel\.bounds\)/.test(browser))

    const zoom = code(await read("src/main/zoom.ts"))
    check("the keyboard and menu path calls it", /rescale\(window\)/.test(zoom))
    const main = code(await read("src/main/index.ts"))
    check("and so does the pinch, which never goes through that path", /window\.webContents\.on\("zoom-changed", \(\) => \{[\s\S]*?rescaleBrowser\(window\)/.test(main))
  }

  // --------------------------------------------------------------- R24-5
  section("Round 24 (5): the work area is not all of the column while the info card is up")
  {
    /*
     * MiMo draws the card over the column's inline end and holds clear only
     * what keeps its reading column from going under it, so a window with room
     * gives up nothing and the conversation sits half the card's width right
     * of what can be seen. The user chose the conversation centred in what is
     * left, at every width - a deliberate difference, recorded in HANDOFF.
     */
    const app = code(await read("src/renderer/src/App.vue"))
    check(
      "the card holds its whole width clear whenever it is inline",
      /const infoInset = computed\(\(\) => \(infoInline\.value \? `\$\{INFO_PANEL_WIDTH\}px` : "0px"\)\)/.test(app),
      app.slice(app.indexOf("const infoInset"), app.indexOf("const infoInset") + 200),
    )
    check("MiMo's clamp, which gave up nothing on a wide window, is gone", !/INFO_PANEL_WIDTH \* 2 - mainWidth/.test(app) && !/viewportWide/.test(app))

    const column = code(await read("src/renderer/src/components/Toasts.vue"))
    check(
      "the notice column takes the card out of the work area before it finds the middle",
      /\.info-card:not\(\.floating\)/.test(column) && /centre\.value = `\$\{Math\.round\(\(start \+ end\) \/ 2\)\}px`/.test(column),
      column.slice(column.indexOf("function measure"), column.indexOf("function measure") + 700),
    )
    check("and reads which end the card holds from its own box, so no reading direction is assumed", /card\.left - box\.left > box\.right - card\.right/.test(column))
  }
}
