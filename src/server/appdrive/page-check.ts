/**
 * Loads a local page in a headless browser and reports what is wrong with it,
 * the way a person opening it would find out: errors in the console, a
 * function the page needs that is not there, shapes with numbers that are not
 * numbers - and, because an animated page is only wrong over time, with its
 * animation run forward.
 *
 * Why it runs the animation forward on a clock of its own. A headless browser
 * paints a couple of frames and stops, so a page that is fine on its first
 * frame and broken on its hundredth looks clean. Measured on pages a model
 * wrote: the checks passed on pages whose figure wandered across the screen
 * after two seconds, which only showed in a real window. The page's
 * `requestAnimationFrame`, timers, `Date` and `performance.now` are therefore
 * replaced before any of its scripts run, and the checker steps them by hand -
 * eight seconds in a few milliseconds - looking after every step. CSS animations
 * run on the browser's own clock and are not stepped; they raise no script errors.
 *
 * It uses the browser and DevTools connection the app tool already has
 * (browser.ts, cdp.ts), with a throwaway profile, and leaves nothing running.
 */
import { pathToFileURL } from "node:url"
import { Cdp, browserSocketURL, type CdpEvent } from "./cdp"
import { closeBrowser, findBrowser, launchBrowser, type LaunchedBrowser } from "./browser"

export interface PageIssue {
  /** The part of the page the problem belongs to when the caller named parts (layers); empty when it is not known. */
  block: string
  text: string
}

export interface PageCheckOptions {
  /** Absolute path of the HTML file. */
  file: string
  /** Layer element id -> the name of the part that draws it, to say whose problem a problem is and to find empty layers. */
  layers?: Record<string, string>
  /** Global functions the page must define, such as `update_bg`. */
  requireFunctions?: string[]
  /** JavaScript run in the page before the animation starts; it may set `window.__specChecks = (add) => {...}` and push to `window.__samplers`. */
  checksSource?: string
  /** How many seconds of animation to run forward (default 8). */
  seconds?: number
  signal?: AbortSignal
}

export interface PageCheckResult {
  issues: PageIssue[]
  /** The browser that ran it, by file name. */
  browser: string
}

/** Runs before the page's own scripts: records what the page logs and fails, and takes over the animation clock. */
export const PAGE_HOOK = String.raw`
window.__errs = [];
(function () {
  var ce = console.error;
  console.error = function () {
    try {
      window.__errs.push(Array.prototype.slice.call(arguments).map(function (a) {
        return a && a.stack ? (a.name + ': ' + a.message + ' @ ' + (a.stack.split('\n')[1] || '').trim()) : String(a);
      }).join(' '));
    } catch (e) {}
    ce.apply(console, arguments);
  };
  window.addEventListener('error', function (e) { window.__errs.push('window error: ' + e.message); });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    window.__errs.push('unhandled rejection: ' + (r && r.stack ? r.name + ': ' + r.message + ' @ ' + r.stack : String(r)));
  });
  var NUMATTR = /^(d|points|transform|viewBox|cx|cy|r|rx|ry|x|y|x1|x2|y1|y2|dx|dy|width|height|stroke-width|opacity|stroke-dashoffset)$/;
  window.__numAttr = NUMATTR;
  var ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  // Walks the path data rather than splitting it: an arc's two flags are single digits that may run into what follows (A1 1 0 011 5).
  function badPath(v) {
    var s = v.trim();
    if (!s) return null;
    if (!/^[Mm]/.test(s)) return 'path data does not start with a moveto (M)';
    var number = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
    var cmd = null, n = 0, i = 0;
    function finish() {
      if (cmd === null) return null;
      var need = ARGS[cmd.toUpperCase()];
      if (need === 0 ? n !== 0 : (n === 0 || n % need !== 0)) return 'path command ' + cmd + ' has ' + n + ' numbers (needs a multiple of ' + need + ')';
      return null;
    }
    while (i < s.length) {
      var c = s[i];
      if (/[\s,]/.test(c)) { i++; continue; }
      if (/[A-Za-z]/.test(c)) {
        var wrong = finish();
        if (wrong) return wrong;
        if (ARGS[c.toUpperCase()] === undefined) return 'unknown path command ' + c;
        cmd = c; n = 0; i++;
        continue;
      }
      if ((cmd === 'A' || cmd === 'a') && (n % 7 === 3 || n % 7 === 4)) {
        if (c !== '0' && c !== '1') return 'arc flag must be 0 or 1, not ' + c;
        i++; n++;
        continue;
      }
      number.lastIndex = i;
      var m = number.exec(s);
      if (!m) return 'unexpected ' + JSON.stringify(c) + ' in path data';
      i += m[0].length; n++;
    }
    return finish();
  }
  window.__badPath = badPath;
  var seen = {};
  function report(name, val, why) {
    var st = (new Error()).stack || '';
    var m = st.match(/(?:init|update)_[A-Za-z0-9_]+/);
    var key = name + '|' + why.replace(/\d+/g, '#') + '|' + (m ? m[0] : '');
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] > 1) return;
    window.__errs.push('setAttribute(' + name + ') invalid value: ' + why + '; value="' + String(val).slice(0, 70) + '" ' + (m ? '@ ' + m[0] : ''));
  }
  var sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, val) {
    try {
      var s = String(val);
      if (NUMATTR.test(name)) {
        if (/NaN|undefined|Infinity/.test(s)) report(name, s, 'contains NaN/undefined/Infinity');
        else if (name === 'd') {
          var w = badPath(s);
          if (w) report(name, s, w);
        }
      }
    } catch (e) {}
    return sa.apply(this, arguments);
  };
  // The page's whole sense of time runs on this one clock: frames, timers and both ways of asking the time. Only the checker's own
  // pauses (__yield) keep a real timer, so a page's promises and queued events get to run between steps.
  var fake = { t: 0, q: [], timers: [], dead: {}, id: 0 };
  var RealDate = Date, realTimeout = window.setTimeout.bind(window), start = RealDate.now();
  function wallClock() { return start + fake.t; }
  function FakeDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!new.target) return new RealDate(wallClock()).toString();
    return Reflect.construct(RealDate, args.length ? args : [wallClock()], new.target);
  }
  FakeDate.prototype = RealDate.prototype;
  RealDate.prototype.constructor = FakeDate;
  FakeDate.now = wallClock;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;
  function arm(cb, ms, args, repeats) {
    // At least a millisecond: a timer that re-arms itself at zero must still let the clock move.
    var wait = Math.max(1, Number(ms) || 0), id = ++fake.id;
    fake.timers.push({ id: id, due: fake.t + wait, cb: cb, args: args, every: repeats ? wait : 0 });
    return id;
  }
  window.setTimeout = function (cb, ms) { return arm(cb, ms, Array.prototype.slice.call(arguments, 2), false); };
  window.setInterval = function (cb, ms) { return arm(cb, ms, Array.prototype.slice.call(arguments, 2), true); };
  window.clearTimeout = window.clearInterval = function (id) { fake.timers = fake.timers.filter(function (t) { return t.id !== id; }); };
  window.requestAnimationFrame = function (cb) { var id = ++fake.id; fake.q.push({ id: id, cb: cb }); return id; };
  window.cancelAnimationFrame = function (id) { fake.dead[id] = true; };
  Performance.prototype.now = function () { return fake.t; };
  function call(cb, args) {
    try { if (typeof cb === 'function') cb.apply(window, args); else (0, eval)(String(cb)); } catch (e) { console.error(e); }
  }
  function dueBy(end) {
    var first = null;
    fake.timers.forEach(function (t) { if (t.due <= end && (!first || t.due < first.due)) first = t; });
    return first;
  }
  window.__advance = function (ms, step) {
    var end = fake.t + ms;
    while (fake.t < end) {
      var target = fake.t + step, timer;
      while ((timer = dueBy(target))) {
        fake.t = timer.due;
        if (timer.every) timer.due += timer.every;
        else fake.timers.splice(fake.timers.indexOf(timer), 1);
        call(timer.cb, timer.args);
      }
      fake.t = target;
      var q = fake.q; fake.q = [];
      for (var i = 0; i < q.length; i++) { if (!fake.dead[q[i].id]) call(q[i].cb, [fake.t]); }
    }
  };
  window.__yield = function () { return new Promise(function (resolve) { realTimeout(resolve, 0); }); };
  window.__samplers = [];
})();
`

/** Evaluated once the page has loaded; runs the animation forward and answers the issues as a JSON string. */
export const PAGE_CHECKER = String.raw`
async function (cfg) {
  var L = cfg.layers || {};
  var issues = [];
  var add = function (block, text) { if (!issues.some(function (i) { return i.block === block && i.text === text; })) issues.push({ block: block, text: text }); };
  var blockOf = function (s) { var m = String(s).match(/(?:init|update)_([A-Za-z0-9_]+)/); return m ? m[1] : ''; };
  var layerBlock = function (el) { var g = el.closest('g[id]'); while (g && !L[g.id]) g = g.parentElement && g.parentElement.closest('g[id]'); return g ? { id: g.id, block: L[g.id] } : { id: '', block: '' }; };
  var flush = function () { (window.__errs || []).splice(0).forEach(function (e) { add(blockOf(e), 'Runtime error: ' + e.slice(0, 260)); }); };
  var scan = function () {
    flush();
    document.querySelectorAll('path[d]').forEach(function (el) {
      var d = el.getAttribute('d') || '';
      var why = window.__badPath ? window.__badPath(d) : null;
      if (why) { var lb = layerBlock(el); add(lb.block, '<path> has an invalid d attribute: ' + why + '; value starts with "' + d.slice(0, 60) + '"' + (lb.id ? '; layer ' + lb.id : '') + '.'); }
    });
    document.querySelectorAll('svg *').forEach(function (el) {
      for (var k = 0; k < el.attributes.length; k++) {
        var a = el.attributes[k];
        // Only attributes that hold numbers: an id or a label may spell NaN and mean nothing by it.
        if (window.__numAttr.test(a.name) && /\bNaN\b/.test(a.value)) {
          var lb = layerBlock(el);
          add(lb.block, '<' + el.tagName + '> attribute ' + a.name + ' contains NaN (value ' + a.value.slice(0, 60) + ')' + (lb.id ? '; layer ' + lb.id : '') + '. Find the variable or calculation that produces it.');
          return;
        }
      }
    });
  };
  try { if (cfg.checksSource) (new Function(cfg.checksSource))(); } catch (e) { add('', 'The checks file itself failed: ' + e.message); }
  scan();
  var ok = typeof window.__advance === 'function';
  var steps = Math.max(1, Math.min(60, Math.round((cfg.seconds || 8) * 2.5)));
  for (var i = 0; ok && i < steps; i++) {
    window.__advance(400, 33);
    // A rejected promise is only announced once this task has ended, so without a pause it would never be seen.
    await window.__yield();
    (window.__samplers || []).forEach(function (f) { try { f(); } catch (e) {} });
    scan();
  }
  [].slice.call(document.scripts).forEach(function (s) {
    var m = s.textContent.match(/block (\w+)/);
    if (!m) return;
    try { new Function(s.textContent); } catch (e) { add(m[1], 'Script syntax error: ' + e.message); }
  });
  Object.keys(L).forEach(function (id) { var el = document.getElementById(id); if (!el || el.children.length === 0) add(L[id], 'Layer ' + id + ' is empty: nothing was drawn into it.'); });
  (cfg.requireFunctions || []).forEach(function (f) { if (typeof window[f] !== 'function') add(blockOf(f), 'The page does not define window.' + f + ' (the script may be incomplete or cut off).'); });
  try { if (window.__specChecks) window.__specChecks(add); } catch (e) { add('', 'The checks file failed while running: ' + e.message); }
  return JSON.stringify(issues);
}
`

/** Console lines every page produces that are not a fault of the page. */
function isNoise(text: string): boolean {
  return /favicon/i.test(text)
}

export async function checkPage(options: PageCheckOptions): Promise<PageCheckResult> {
  const executable = findBrowser()
  if (!executable) throw new Error("No Chrome or Edge was found on this machine (set MCODE_APP_BROWSER to the browser to use).")
  let browser: LaunchedBrowser | undefined
  let cdp: Cdp | undefined
  const native = new Set<string>()
  const cancelled = () => {
    if (options.signal?.aborted) throw new Error("the check was cancelled")
  }
  let loaded: (ok: boolean) => void = () => undefined
  /*
   * Through the connection, as the app driver closes its browser: Edge's launcher
   * hands over to another process and exits, so killing the launcher leaves the
   * browser running. Also what Stop does, which rejects whatever is being waited for.
   */
  const shut = async () => {
    loaded(false)
    if (cdp && !cdp.closed) {
      await cdp.send("Browser.close", {}, undefined, 3_000).catch(() => undefined)
      cdp.close()
    }
  }
  const onAbort = () => void shut()
  options.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    cancelled()
    browser = await launchBrowser(executable, 15_000, { headless: true })
    cancelled()
    cdp = await Cdp.connect(await browserSocketURL(browser.port))
    cancelled()
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
    const send = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeout?: number) => cdp!.send<T>(method, params, sessionId, timeout)
    const load = new Promise<boolean>((resolve) => (loaded = resolve))
    cdp.on((event: CdpEvent) => {
      if (event.sessionId !== sessionId) return
      if (event.method === "Page.loadEventFired") loaded(true)
      if (event.method === "Log.entryAdded") {
        const entry = (event.params.entry ?? {}) as { level?: string; text?: string }
        if (entry.level === "error" && entry.text && !isNoise(entry.text)) native.add(entry.text)
      }
    })
    await send("Page.enable")
    await send("Log.enable")
    await send("Runtime.enable")
    await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HOOK })
    // A page that did not load is not a page without problems: the checks would pass on the blank tab it left.
    const navigation = await send<{ errorText?: string }>("Page.navigate", { url: pathToFileURL(options.file).href })
    if (navigation.errorText) throw new Error(`the page did not load: ${navigation.errorText}`)
    const timer = setTimeout(() => loaded(false), LOAD_TIMEOUT_MS)
    const finished = await load
    clearTimeout(timer)
    cancelled()
    if (!finished) throw new Error(`the page did not finish loading within ${LOAD_TIMEOUT_MS / 1000}s`)
    // Scripts waiting on a frame or a timer start on the first step; this is for what the browser itself is still doing, such as decoding an image.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const config = { layers: options.layers ?? {}, requireFunctions: options.requireFunctions ?? [], checksSource: options.checksSource ?? "", seconds: options.seconds ?? 8 }
    const answer = await send<{ result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
      "Runtime.evaluate",
      { expression: `(${PAGE_CHECKER})(${JSON.stringify(config)})`, awaitPromise: true, returnByValue: true },
      30_000,
    )
    if (answer.exceptionDetails) throw new Error(`The page checker failed: ${answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "unknown"}`)
    const issues = JSON.parse(String(answer.result?.value ?? "[]")) as PageIssue[]
    // What the browser itself complained about while parsing the page, which no script of the page ever sees.
    for (const text of native) issues.push({ block: "", text: `Browser console error: ${text}` })
    return { issues, browser: executable.split(/[\\/]/).pop() ?? executable }
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    await shut()
    if (browser) await closeBrowser(browser)
  }
}

/** How long a page may take to fire its load event. */
const LOAD_TIMEOUT_MS = 15_000

/** The issues as a short report: grouped by the part they belong to, in the order found. */
export function describeIssues(issues: readonly PageIssue[]): string {
  if (issues.length === 0) return "No problems found."
  // The same fault shows again with other numbers on every frame; one line says it, with how often.
  const by = new Map<string, Map<string, { text: string; count: number }>>()
  for (const issue of issues) {
    const block = issue.block || "(page)"
    const kinds = by.get(block) ?? new Map<string, { text: string; count: number }>()
    by.set(block, kinds)
    const key = issue.text.replace(/\d+(\.\d+)?/g, "#")
    const known = kinds.get(key)
    if (known) known.count++
    else kinds.set(key, { text: issue.text, count: 1 })
  }
  const lines = [`${issues.length} problem(s) found:`]
  for (const [block, kinds] of by) {
    lines.push("", `${block}:`)
    const shown = [...kinds.values()].slice(0, MOST_KINDS_SHOWN)
    for (const kind of shown) lines.push(`- ${kind.text}${kind.count > 1 ? ` (x${kind.count} with other numbers)` : ""}`)
    if (kinds.size > shown.length) lines.push(`- ...and ${kinds.size - shown.length} more kind(s) of problem in ${block}, fewer to fix first.`)
  }
  return lines.join("\n")
}

/** How many different problems one part is shown with; fixing those usually clears the rest. */
const MOST_KINDS_SHOWN = 6
