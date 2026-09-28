/**
 * The scripts the app tool runs inside a page, kept as plain source text: they
 * run in the page's own JavaScript world, not this process's, so nothing here
 * may lean on an import or on the bundler.
 *
 * State lives on `window.__mcodeApp`: every element the snapshot lists gets a
 * number that stays the same for as long as the element exists, and every
 * number stays usable after that element drops out of a listing - a button on
 * a tab that is hidden now is clicked by its old number once a step shows the
 * tab again, which is what makes a batch of steps possible. Both directions are
 * weak (a WeakMap, WeakRefs), so the page's own garbage collection is
 * untouched, and nothing is written into the page's DOM - an attribute there
 * could trip the app's own observers or snapshot tests.
 */

/**
 * Lists what a person could act on, and what the page says.
 *
 * Interactive means a native control, an ARIA widget role, something focusable,
 * or - for the many apps that make buttons out of divs - the outermost element
 * with a pointer cursor. While a modal dialog is open only what is inside it is
 * listed, as a screen reader would present it: that is all a person could
 * reach, and it keeps the list short.
 */
export const SNAPSHOT = String.raw`(function (limit, base) {
  var S = window.__mcodeApp || (window.__mcodeApp = { next: 1, ids: new WeakMap() });
  if (!S.known) S.known = new Map();
  // A page loaded anew starts its state over; its numbers go on from the driver's, so an old number never lands on a new element.
  if (S.next < base) S.next = base;
  if (!S.doc) S.doc = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var WIDGET = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[role=treeitem],[contenteditable=''],[contenteditable=true],[tabindex]:not([tabindex='-1']),[onclick]";
  function shown(el) {
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    var r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }
  function squash(text, max) {
    text = String(text || "").replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }
  function roleOf(el) {
    var role = el.getAttribute("role");
    if (role) return role.split(" ")[0];
    var tag = el.tagName;
    if (tag === "A") return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      var type = (el.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
      if (type === "file") return "file";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "clickable";
  }
  function labelled(el) {
    var ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    var home = el.getRootNode();
    return ids.map(function (id) { var node = home.getElementById ? home.getElementById(id) : document.getElementById(id); return node ? node.innerText || node.textContent : ""; }).join(" ");
  }
  function nameOf(el) {
    var name = el.getAttribute("aria-label") || labelled(el);
    if (!name && el.labels && el.labels.length) {
      name = Array.prototype.map.call(el.labels, function (label) {
        var copy = label.cloneNode(true);
        Array.prototype.forEach.call(copy.querySelectorAll("select,input,textarea,button"), function (inner) { inner.remove(); });
        return copy.textContent;
      }).join(" ");
    }
    if (!name && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
      var type = (el.type || "").toLowerCase();
      name = type === "button" || type === "submit" || type === "reset" ? el.value : el.placeholder;
    }
    if (!name && el.tagName !== "SELECT") name = el.innerText;
    if (!name) {
      var img = el.querySelector && el.querySelector("img[alt],svg[aria-label],[title]");
      if (img) name = img.getAttribute("alt") || img.getAttribute("aria-label") || img.getAttribute("title");
    }
    if (!name) name = el.getAttribute("title") || el.getAttribute("name") || el.id || "";
    return squash(name, 80);
  }
  function statesOf(el, role) {
    var out = [];
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    if (el.checked || el.getAttribute("aria-checked") === "true") out.push("checked");
    if (el.getAttribute("aria-selected") === "true" || (el.tagName === "OPTION" && el.selected)) out.push("selected");
    var expanded = el.getAttribute("aria-expanded");
    if (expanded === "true") out.push("expanded");
    if (expanded === "false") out.push("collapsed");
    if (el.getAttribute("aria-pressed") === "true") out.push("pressed");
    var current = el.getAttribute("aria-current");
    if (current && current !== "false") out.push("current");
    if (el.getRootNode().activeElement === el && role === "textbox") out.push("focused");
    if (role === "textbox" && !el.isContentEditable) out.push("value=" + JSON.stringify(squash(el.value, 40)));
    if (role === "textbox" && el.isContentEditable) out.push("value=" + JSON.stringify(squash(el.innerText, 40)));
    if (el.tagName === "SELECT") out.push("value=" + JSON.stringify(squash(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : "", 40)));
    if (role === "slider" && el.value !== undefined) out.push("value=" + el.value);
    var r = el.getBoundingClientRect();
    var view = el.ownerDocument.defaultView || window;
    if (r.bottom < 0 || r.top > view.innerHeight || r.right < 0 || r.left > view.innerWidth) out.push("offscreen");
    return out;
  }
  var dialogs = Array.prototype.filter.call(document.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog]"), function (d) {
    return shown(d) && (d.matches(":modal") || d.getAttribute("aria-modal") === "true");
  });
  var scope = dialogs.length ? dialogs[dialogs.length - 1] : document.body || document.documentElement;
  /*
   * Walked in document order rather than queried: a query stops at a shadow
   * root and at a frame, and web components and embedded pages hide most of
   * a modern app's controls behind one or the other. Open shadow roots and
   * frames from the same site are walked into; a frame from another site
   * cannot be read from here, and is counted so the model is told.
   */
  var list = [];
  var frameDocs = [];
  var shadows = [];
  var foreign = 0;
  var visited = 0;
  function consider(el) {
    if (el.matches(WIDGET)) {
      if (shown(el)) list.push(el);
      return;
    }
    if (!el.parentElement) return;
    var view = el.ownerDocument.defaultView || window;
    if (view.getComputedStyle(el).cursor !== "pointer" || view.getComputedStyle(el.parentElement).cursor === "pointer") return;
    if (el.closest(WIDGET) || el.querySelector(WIDGET) || !shown(el)) return;
    list.push(el);
  }
  function walk(parent) {
    var kids = parent.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (visited++ > 8000) return;
      var el = kids[i];
      consider(el);
      if (el.shadowRoot) { shadows.push(el.shadowRoot); walk(el.shadowRoot); }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        var inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }
        if (inner && inner.body) { frameDocs.push(inner); walk(inner.body); }
        else foreign++;
        continue;
      }
      walk(el);
    }
  }
  walk(scope);
  var lines = [];
  for (var j = 0; j < list.length && lines.length < limit; j++) {
    var node = list[j];
    var id = S.ids.get(node);
    if (!id) { id = S.next++; S.ids.set(node, id); S.known.set(id, new WeakRef(node)); }
    var role = roleOf(node);
    var states = statesOf(node, role);
    lines.push("[" + id + "] " + role + " " + JSON.stringify(nameOf(node)) + (states.length ? " " + states.join(" ") : ""));
  }
  var text = [];
  var seen = new Set();
  var budget = 3000;
  // innerText stops at a shadow root and at a frame: their words are gathered from each in turn.
  var shadowText = shadows.map(function (shadow) { return Array.prototype.map.call(shadow.children, function (child) { return child.innerText || ""; }).join("\n"); });
  var pages = [String(scope.innerText || "")].concat(shadowText, frameDocs.map(function (d) { return String(d.body.innerText || ""); }));
  pages.join("\n").split(/\n+/).forEach(function (line) {
    line = squash(line, 160);
    if (!line || seen.has(line) || budget <= 0) return;
    seen.add(line);
    budget -= line.length;
    text.push(line);
  });
  return { title: document.title, url: location.href, doc: S.doc, modal: dialogs.length > 0 ? nameOf(scope) || "dialog" : "", elements: lines, more: Math.max(0, list.length - lines.length), text: text, foreignFrames: foreign };
})`

/**
 * Brings an element into view and says where its middle is, and what - if
 * anything - is drawn over that point, so a click that would land on an
 * overlay is reported instead of silently hitting the wrong thing.
 */
export const LOCATE = String.raw`(function (ref) {
  var S = window.__mcodeApp;
  var held = S && S.known && S.known.get(ref);
  var el = held && held.deref();
  if (!held) return { error: "unknown" };
  if (!el || !el.isConnected) return { error: "gone" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  var r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { error: "hidden" };
  // A frame's element is placed by its frame, and every frame above it, in the page's own coordinates.
  var x = r.left + r.width / 2;
  var y = r.top + r.height / 2;
  for (var view = el.ownerDocument.defaultView; view && view.frameElement; view = view.parent) {
    var frame = view.frameElement.getBoundingClientRect();
    x += frame.left + view.frameElement.clientLeft;
    y += frame.top + view.frameElement.clientTop;
  }
  // What is really at that point: through open shadow roots and same-site frames, not stopping at their hosts.
  var top = document.elementFromPoint(x, y);
  var ox = 0, oy = 0;
  for (var depth = 0; depth < 30 && top; depth++) {
    var next = null;
    if (top.shadowRoot) next = top.shadowRoot.elementFromPoint(x - ox, y - oy);
    else if (top.tagName === "IFRAME" || top.tagName === "FRAME") {
      try {
        var box = top.getBoundingClientRect();
        if (top.contentDocument) { ox += box.left + top.clientLeft; oy += box.top + top.clientTop; next = top.contentDocument.elementFromPoint(x - ox, y - oy); }
      } catch (e) { next = null; }
    }
    if (!next || next === top) break;
    top = next;
  }
  function inside(inner, outer) {
    // Up through parents, from a shadow root to its host, and from a frame's document to the frame.
    for (var node = inner; node; node = node.parentNode || node.host || (node.defaultView && node.defaultView.frameElement) || null) {
      if (node === outer) return true;
    }
    return false;
  }
  var covered = "";
  if (top && !inside(top, el) && !inside(el, top)) {
    covered = (top.getAttribute("aria-label") || top.innerText || top.tagName || "").replace(/\s+/g, " ").trim().slice(0, 60);
  }
  var disabled = Boolean(el.disabled || el.getAttribute("aria-disabled") === "true");
  var options = el.tagName === "SELECT" ? Array.prototype.map.call(el.options, function (o) { return o.text.trim(); }).slice(0, 30) : undefined;
  return { x: x, y: y, covered: covered, disabled: disabled, tag: el.tagName, options: options };
})`

/** Gives an element the keyboard, with its contents selected when they are to be replaced. */
export const FOCUS = String.raw`(function (ref, clear) {
  var S = window.__mcodeApp;
  var held = S && S.known && S.known.get(ref);
  var el = held && held.deref();
  if (!el || !el.isConnected) return { error: "gone" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  el.focus();
  if (clear) {
    if (typeof el.select === "function") el.select();
    else if (el.isContentEditable) document.execCommand("selectAll");
  }
  var home = el.getRootNode();
  return { focused: home.activeElement === el || el.contains(home.activeElement) };
})`

/** Chooses an option of a native select by its value or its visible text, and tells the page, as a person's choice would. */
export const CHOOSE = String.raw`(function (ref, wanted) {
  var S = window.__mcodeApp;
  var held = S && S.known && S.known.get(ref);
  var el = held && held.deref();
  if (!el || !el.isConnected) return { error: "gone" };
  if (el.tagName !== "SELECT") return { error: "not-select" };
  var options = Array.prototype.slice.call(el.options);
  var match = options.find(function (o) { return o.value === wanted; }) || options.find(function (o) { return o.text.trim() === wanted; }) || options.find(function (o) { return o.text.toLowerCase().indexOf(String(wanted).toLowerCase()) >= 0; });
  if (!match) return { error: "no-option", options: options.map(function (o) { return o.text.trim(); }).slice(0, 30) };
  el.value = match.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { chosen: match.text.trim() };
})`

/**
 * Starts recording when the page last changed. The waiting itself is done
 * from this process (driver.ts `settle`), by reading `quietFor` - never with
 * the page's own timers, which Chromium slows to once a second in a window
 * that is in the background, and an app under test usually is.
 */
export const WATCH = String.raw`(function () {
  var S = window.__mcodeApp || (window.__mcodeApp = { next: 1, ids: new WeakMap() });
  S.changed = performance.now();
  if (!S.observer) {
    S.observer = new MutationObserver(function () { S.changed = performance.now(); });
    // Everything but style: an animation driven from script rewrites style every frame, and would keep every step waiting its full cap.
    S.observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden", "disabled", "open", "value", "checked", "selected", "src", "href", "role", "aria-hidden", "aria-expanded", "aria-selected", "aria-checked", "aria-pressed", "aria-disabled", "aria-busy", "aria-current"] });
  }
  return true;
})`

/** How long the page has gone without a change, and whether it has finished loading. */
export const QUIET_FOR = String.raw`(function () {
  var S = window.__mcodeApp;
  return { quiet: S && S.changed !== undefined ? performance.now() - S.changed : 0, loaded: document.readyState === "complete", watched: Boolean(S && S.observer) };
})`

/** Whether the page's text now includes (or no longer includes) something. */
export const HAS_TEXT = String.raw`(function (wanted) {
  return String(document.body ? document.body.innerText : "").indexOf(wanted) >= 0;
})`
