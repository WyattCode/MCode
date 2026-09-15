---
name: design-blueprint
description: Write a design brief and layout plan before building any visual deliverable - slide decks, landing pages, dashboards, posters, infographics, reports with charts. Use when the user asks to design, mock up or restyle something visual, including short requests like "make a slide about X", so the result follows a plan instead of a template.
aliases:
  - design-brief
---

# Design blueprint

Build nothing visual until this plan exists. It takes a few minutes and saves
rebuilding.

## 1. Brief (a few lines)

- Audience and setting: who sees it, where (projector, phone, printed page).
- The one message they should leave with.
- Tone in three words.
- Hard constraints: brand colours or fonts, template, size, language, deadline.

Ask with the question tool only for constraints that would change the design.

## 2. Content inventory

List every piece of content with its role: headline, key number, supporting
point, chart, image, call to action. Rank by importance. Cut what does not serve
the message.

## 3. Structure

- For decks: one line per slide, the takeaway it states, and its layout type
  (title, big number, chart with caption, two columns, quote, section break).
- For pages and posters: sections from top to bottom with their purpose, and the
  single thing the eye should land on first in each.
- Sketch each distinct layout as a box plan in text, for example
  `[headline, full width] / [chart 2/3 | caption 1/3] / [source, small]`.

## 4. Visual system

- Grid: columns and margins.
- Type: families, a size scale, weights used.
- Colour: background, text, one accent, data colours for charts (ordered, and
  readable by colour-blind viewers).
- Imagery and icon style.
- What repeats on every page (footer, page numbers, logo placement).

## 5. Decisions and trade-offs

Note each choice that was not obvious and why it was made ("chart instead of
table: the trend matters more than exact values"). This is what lets the plan be
questioned before the work is done.

## Output

Write the blueprint to `DESIGN.md` in the project (or show it in the reply for a
single slide or small page), confirm it with the user when the work is large,
then build with the matching skill: pptx for decks, frontend-design for pages,
data-analytics or visualizer for charts.
