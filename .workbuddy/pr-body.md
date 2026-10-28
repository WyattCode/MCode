# The pad's remaining screens, measured against Claude's phone

Closes out the visual pass on the Android client: **artifacts, inline code, the
diff sheet, 创建 PR, and the whole dark theme**, each measured off a reference
rather than read off the code.

23 commits, +1979 / -159 in `android/`, 132 unit tests (was 129).

## What is new

- **The artifacts page** — cards re-measured to 328.0 × 98.8 with a **0.4 dp**
  outline (it drew 3 px), inset 12, a 112.0 × 75.2 well. The palette badge was
  redrawn from a 1:1 dot map of its ink: it had been a pinched circle that read as
  a flower at 24 dp. The **list** row gained the kind badge it was missing — five
  elements now, as the desktop's row has.
- **Inline code** — the chip was never measurable because no reference carried
  one. Obtained by asking Claude for a sentence with three spans. Two of its four
  figures had been wrong in kind: the phone sets the span in **blue**
  (40,78,144) on (237,237,235), not the desktop's grey-on-grey; and its height
  came from `getBoundingBox`, which returns the **line's** box, so at 17.4 on a
  30 dp pitch every chip was a 30 dp band swallowing the lines around it. 17.6 now.
- **The diff sheet** — gutter, per-file `+N`/`-M`, fold bar, and a bottom sheet
  with one connector stroke through the marks' centres (one per group, not one per
  row — `spacedBy` was cutting it into dashes).
- **创建 PR now works.** It was drawn but dead, on the recorded note that the
  gateway can read a pull request and not file one. That was the wrong
  conclusion: the reference's button does not file one either — it opens the
  forge's compare page. `pullRequestUrl` assembles it from `git.status`'s branch
  and `.git/config`'s remote, with 13 tests over the shapes that would otherwise
  404 (scp remotes, `.git` suffix, GitLab's `/-/compare`, `/` escaped, a custom
  default branch, unknown hosts refused).

  Wiring it exposed a real bug: `gitRepo` and `prUrl` were computed only inside
  the changes rail, which runs *while its sheet is open*. In an ordinary
  conversation neither was ever asked for, so the capsule never appeared even in a
  repository on a feature branch.

## What the dark pass found

The surfaces were already right — page (21,21,21), rail (26,26,25) match the
reference to the value. The **ink ladder** did not, and it has three steps where
this had two:

| | reference | was |
|---|---|---|
| muted (a time) | (151,149,142), warm | (138,138,138), neutral |
| faint (a placeholder) | (137,135,130) | (107,104,99) — 30 too dark |

The placeholder is not the muted step at all, and the reference uses **the same
value in light and dark**. Drawing it 30 steps too dark made an empty search
field look already filled in.

Also corrected: the list title was `Medium` where the reference is `Normal`
(measured as stroke width — 5 px against 3), the dark button row's fill and
hairline were both too far from the page to read as a capsule, and the dark diff
wash was off by three.

## Three readings that were wrong, and are now written down

1. **The tool row's verb is not body ink.** Recorded as (19,19,19) — but that was
   a row that had been *expanded*, where the verb joins the prose. A finished row
   is one flat colour from verb to sentence end, in both modes.
2. **The artifacts well was never a defect.** The reference's one record draws a
   2×2 collage of *that app's own pages* — a preview of a web app, not of a file.
   The desktop's tile is a 38 × 38 SVG mark. A type mark is what this product does.
3. **The references themselves.** Three files filed as `CL-ART*.png` were
   screenshots of *this* app. The only reliable reading is the sidebar's own
   words; the blue-arc count that was meant to tell them apart is wrong in both
   directions.

## Verification

Every value above was measured on the pad in both modes, not inferred. 132 unit
tests. Screenshots kept in `.workbuddy/shots/` — `REF-artifacts.png`,
`REF-inline2.png`, `REF-claude-diffpanel.png`, `SIDE-*.png` for the pairs.

One thing deliberately **not** done: the app-kind preview in the artifacts well
needs a renderer, not a protocol field — the desktop captures a live window. No
app records exist on this profile, so it cannot even be exercised here.