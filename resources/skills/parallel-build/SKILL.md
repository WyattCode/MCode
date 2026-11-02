---
name: parallel-build
description: Build one large artifact - an animated web page, a multi-part document, a generated asset set - by splitting it into parts that are written side by side from a shared written contract, then assembling and checking them. Use when the work is big, can be cut into three to five parts that do not need each other's output, and the writing (not the looking-around) is what takes the time. Not for small tasks, for edits to existing code, or for work that has to explore the project first.
aliases:
  - parallel
---

# Parallel build

One long piece of writing takes as long as its tokens take to come out. Written as
four or five parts at once it takes about as long as the longest part. The price
is that the parts must fit together without having seen each other, and any one
of them can be wrong. The assembling and checking are already written, in this
skill's `scripts` folder. Your whole job is: the contract, the part prompts, one
`fanout`, then run the scripts and fix what the check reports.

Measured on one local model: the same animated page took 14 minutes written by an
agent step by step; in five parts with thinking off the writing takes about 3
minutes. Time is lost to anything else: writing glue code, writing checks, probing
the machine, reading the parts. So do none of those. Do not use the `task` tool
for this. Do not look for node or a browser: assembling is the Python script below
and checking is the `verify_page` tool. Do not read the parts to see what they say;
the check will say what is wrong. Do not read the scripts either: everything you
need to know about them is written here.

Plan for about ten steps: load this skill, write `contract.md`, write
`parts.json`, `fanout`, assemble, `verify_page`, then repair rounds, then present
the page. A conversation on a local model may be cut off after about 32 steps, and
a step spent past the finish line is a step the user waits for.

## 1. Decide whether to

Use it when the result is one artifact with three to five natural parts, each
describable without seeing the others' output, and long enough that writing it
serially would take several minutes. **At most five parts**: five run at once,
the slowest sets the total, and every extra part is another that can fail. The
bundled assembler fits a page of drawn layers (SVG layers filled by parts, each
animated by one function). For a document or a set of files the method is the
same with your own assembly: keep to steps 2, 3 and 6.

## 2. Write contract.md and parts.json

Make a work folder in the project, for example `work/`; everything lives in it:
`contract.md`, `parts.json`, `parts/` (the answers), `checks.js`, `page.html`.

**contract.md** is the whole trick: parts written apart fit only if they agreed
on the same facts beforehand. Put in it:

- the shared frame: canvas size (the viewBox), coordinate system, units;
- every number two parts both depend on (where one part meets another, sizes,
  colours, ids);
- the interface of a part: it fills the layers named in parts.json, and defines
  `window.update_<part>(s)` (and optionally `window.init_<part>()`), wrapped in
  its own function; `s` is the shared state the page's loop passes every frame
  (`s.t` seconds, `s.dt`, plus what `state` in parts.json adds); a part animates
  only by `setAttribute` inside its update - never its own timers, CSS animation
  or `requestAnimationFrame`; and nothing in a part may be `pointer-events:none`
  or otherwise change how the page is hit-tested;
- the drawing order of the layers, back to front;
- the output format: for each layer one fenced block written ` ```svg LAYER_NAME `
  (the name on the same line as the fence) holding only the layer's inside - no
  `<svg>`, no outer `<g>` - then one ` ```css ` block (may be empty) and one
  ` ```js ` block; nothing outside the fences;
- id prefixes, one per part, and no external resources.

Give each part a name of letters, digits and underscores (it becomes part of a
function name), an id prefix, and a paragraph on what it owns. Keep parts
about the same size: cut the largest in two rather than the smallest in half.

**parts.json** names the parts, their layers and the drawing order, and states the
measurable facts of the contract as data, so no check has to be written as code:

```json
{ "title": "Pelican on a bike", "canvas": [800, 450], "background": "#0f172a",
  "parts": { "bg": ["L_bg"], "bike": ["L_bikeBack", "L_bikeFront"], "pelican": ["L_pelican"] },
  "order": ["L_bg", "L_bikeBack", "L_bikeFront", "L_pelican"],
  "state": "s.dist = (s.dist || 0) + 280 * s.dt;",
  "expect": [
    { "kind": "shape_near", "part": "bike", "selector": "#L_bikeBack *", "size": [100, 140], "center": [250, 334], "tol": 25 },
    { "kind": "covers", "part": "pelican", "point": [335, 238], "layers": "#L_pelican" },
    { "kind": "small", "part": "pelican", "layers": ["L_pelican"], "max": [450, 330] },
    { "kind": "stable", "part": "pelican", "layer": "L_pelican", "move": 12, "scale": 0.15 },
    { "kind": "moves", "part": "bg", "layer": "L_bg" }
  ] }
```

`state` is JavaScript run once per frame, before the updates, on the shared object
`s` (it keeps its fields between frames). The `expect` kinds, all of them, with the
fields shown above: `shape_near` (an element about this size, centred here; `size`
is `[min, max]` for both width and height, `tol` how far off centre), `covers` (the
topmost thing at a point is in these layers), `small` (nothing in these layers is
bigger than `max`), `stable` (a layer does not wander more than `move` or change size
by more than the fraction `scale` while animating), `moves` (scenery whose content
must change while the animation runs). Every entry takes an optional `text`, the
message to show instead of the usual one. **Every place where one part must meet another gets a `touches` entry**, for
example a foot and its pedal, a hand and its grip, a fork and its wheel's hub:
`{ "kind": "touches", "part": "pelican", "a": "#pl_foot1", "b": "#bk_pedal1", "gap": 12 }`.
It is checked at every moment of the animation, and a part that draws its limbs in
the wrong place passes everything else. For this to work, **the contract must name
the id of each element at a meeting point**, so both the part that draws it and the
check use the same id. Add few other entries, **eight in all at most**: a wrong
entry costs steps on a problem that is not there. Never put `small` on a background or scenery layer
(a scrolling tile is meant to be wider than the canvas), and never put `stable` on
a layer with moving limbs (its box changes as they move): use `stable` on the
body or frame alone, and `moves` to show that the rest is animated.

## 3. Fan out

One `fanout` call, with exactly these argument names:

```json
{ "requests": [ {"name": "bg", "prompt": "You are the bg part. ..."}, {"name": "bike", "prompt": "..."} ],
  "output_dir": "work/parts", "system_file": "work/contract.md", "effort": "off", "must_contain": "```js" }
```

`system_file` sends the contract file to every request as its system prompt, so you
do not type it again. A part's `prompt` says which part it is, what it owns, and
anything particular to it. `effort: "off"` switches thinking off, the fast choice
for a part that only has to be written from a settled plan. `must_contain` makes
the tool itself rerun, once and at once, a part whose answer is not what was asked
(a model sometimes writes a tool call instead of the part), so you do not spend a
step on it. Four requests run at once by default; the slowest part is the wait.

A part the result still reports as failed, or as stopped at `max_tokens`, is rerun
with `fanout` (a higher `max_tokens`, or split).

## 4. Assemble

```
python "<this skill's folder>/scripts/assemble.py" --work work
```

The skill's folder is given when the skill is loaded (a file URL; use it as a
path). **Which Python:** when the `MCODE_PYTHON` environment variable is set, use
that interpreter instead of `python`: `"$MCODE_PYTHON" ...` in bash,
`& $env:MCODE_PYTHON ...` in PowerShell; without it, `python3` on macOS and Linux.
The script needs nothing installed. It writes `work/page.html` and `work/checks.js` and lists each part's
layers; every `WARN` line is a problem to fix at its source (a part that left out a
layer, wrote no js, or never defined its `update_` function, or `parts.json` left
a layer out of `order`). It tolerates the ways
models write fences, puts every part's script in its own `<script>`, and calls each
`update_<part>` inside a try/catch.

## 5. Check before you say it works

```json
{ "file_path": "work/page.html", "checks_file": "work/checks.js",
  "layers": { "L_bg": "bg", "L_bikeBack": "bike", "L_bikeFront": "bike", "L_pelican": "pelican" },
  "require_functions": ["update_bg", "update_bike", "update_pelican"] }
```

`verify_page` runs the animation forward about eight seconds, so problems that only
appear over time are found, and reports each against the part to fix. Do not
write checks of your own: a check you write can be wrong, and then you spend steps
chasing a problem that is not there. Add to `expect` instead. If a reported
problem looks wrong to you, say so in the report rather than bending a part to
satisfy it.

**When `verify_page` reports no problems, you are done with building. Stop.** Do
not open the page, screenshot it, or run scripts in it with the `app` tool: the
check already ran the animation, and a model that cannot see images learns nothing
from a screenshot. Do not tidy or rename. Present the page with `present_files`
(`work/page.html`), then give the report (step 7).

## 6. Repair only what failed

Each part gets **one round of repair**. First decide what each reported problem is:

- The `expect` entry is wrong (it breaks a rule in step 2, or contradicts the
  contract): correct or delete that entry and say so in the report. Do not loosen an
  entry just to make a real problem go away, and do not add anything to the page
  whose only purpose is to satisfy a check (a hidden element that pins a layer's box).
  Name every entry you changed or deleted in the report, with why.
- The problem names a clear place: `edit` the part's file (`work/parts/<part>.txt`),
  reading only what you need to find it. Do not study the other parts.

Then assemble and `verify_page` again. If a part is still reported, do not analyse
it further: rerun that part with `fanout` as three fresh attempts at once, from its
original prompt plus one line on what went wrong (names like `bike_a`, `bike_b`).
Copy each over `work/parts/<part>.txt` in turn, assemble, check, and keep the one
with the fewest problems. If problems remain after that, stop and report them: more
rounds cost more than they recover.

Never replace a part's whole script with a fragment of one: it deletes
`update_<part>` and the page stops animating without any error.

## 7. Report honestly

Say how long it took, which parts needed repair, what `verify_page` checked, and
what it cannot see (looks, taste). If a part is still wrong, say which and why
rather than presenting the page as finished.
