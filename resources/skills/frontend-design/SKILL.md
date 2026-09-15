---
name: frontend-design
description: Give interfaces a deliberate, finished visual design. Use whenever the work produces or changes something a person will see rendered - web pages, landing pages, dashboards, app screens, React, Vue or HTML components, HTML reports - including "make this look better" requests, even when design is never mentioned.
---

# Front-end design

Good interfaces come from a few decisions made on purpose and applied everywhere.

## Decide before you code

1. **Who and what**: who uses this, what they must do first, and what the page
   should feel like (calm, dense, playful, official). One sentence each.
2. **Fit in or stand out**: inside an existing product, read its styles first
   (CSS variables, the component library, spacing and type scale) and match them
   exactly. Only a fresh page gets a direction of its own.
3. **Type**: one family for text, at most one more for headings; a scale of 4-6
   sizes. Use fonts the project already loads or system stacks; add a web font
   only if the project can serve it.
4. **Colour**: a neutral background and text colour, one accent, and colours for
   success, warning and danger. Check text contrast (4.5:1 for body text). Plan
   the dark theme if the product has one.
5. **Space**: a spacing unit (4 or 8 px) and use only its multiples; generous
   outer margins, tighter spacing inside groups.

## Build

- Layout with flex and grid; logical properties (`margin-inline-start`) where the
  project uses them; nothing wider than the viewport.
- Every interactive element needs hover, focus-visible, active and disabled
  states, and a hit area of at least 32 px.
- Design the states people actually meet: loading, empty, error, one item, a
  hundred items, very long text.
- Motion: short (150-250 ms), easing out, and respect `prefers-reduced-motion`.
- Icons from one set at one stroke width; align them to text.

## Check what you built

- Open the page and look at it: for a standalone HTML file, call
  `present_files` so it opens in the side panel; for an app, start its dev
  server with bash and ask the user to look, or take screenshots if the project
  has a browser test tool.
- Resize to a phone width and a wide desktop.
- Read it once as a newcomer: is the first thing to do obvious?

Avoid defaults that make pages look generic: centred everything, gradients on
every surface, shadows on every card, and three near-identical feature boxes.
