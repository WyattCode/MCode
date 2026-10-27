# MCode Remote — where the port stands

Every number below was measured off Claude running on the same pad
(`com.anthropic.claude`, 2272×3408, 2.5 px per dp) with
`.workbuddy/measure_all.py`, except where marked *unverified*.

## 最近记录 (home list) — matched

| element | reference | this app |
|---|---|---|
| header ink | y 56.4..73.2 | 55.2..73.2 |
| search field text | y 119.2 | 122.0 |
| row 1 title | y 174.0, x 26.0 | **174.0, 26.0** |
| row 1 time | y 196.4 | 199.6 |
| row 2 title | y 234.0 | **234.0** |
| row pitch | 60.0 | **60.0** |
| mark | x 26.0..37.6 | 26.0..36.4 |
| title ink | 12.8 | 14.0 |
| time ink | 13.6 | 12.4 |
| filter mark | 16.0×13.6, #383835 | same shape |
| list mark | ticks + rules | same shape |

Left: title and time are each ~1.2 dp tall; the times sit 3 dp low.
No foot capsule on this page — the reference has none.

## Code — matched

| element | reference | this app |
|---|---|---|
| header | 55.6 | 55.2 |
| 设备 | 116.0 / x 28.8 | 115.6 / 29.6 |
| capsule | 164.4, x 16.0..130.8, w 115.2 | **identical** |
| 会话 row | 222.4 / x 28.8 | 221.6 / 29.6 |
| first card | 282.4 | 280.0 |

Its trailing mark is a clock; 最近记录 carries filter + list.

## Drawer — matched

400.0 wide, scrim (169,169,168). Four rows only: 项目 115.2, Code 172.8,
Artifacts 227.6, 定时任务 283.6. 最近使用 at 348.8 with **six** rows at a 43.4
pitch (390.0, 432.4, 476.0, 519.6, 564.4, 606.8), 查看全部 at 654.4,
mark x 30.0..41.6, title x 61.2.
Foot: purple W avatar at the left, black 新建会话 capsule y 832.8,
x 16.0..343.6, 44.0 tall.

Row mark means "the open conversation": `</>` on that one, a round speech bubble
on every other. Row height 41.4 produces the reference's 43.4 pitch.

Known difference: this drawer carries a 设置 row above the account and the
reference does not. It is the only route into the settings pages.

## Conversation pane — matched

Measured against a real thread on the reference (drawer → Main), which is the only
benchmark that shows the header over a conversation.

| element | reference | this app |
|---|---|---|
| back arrow | x 400.8..414.8 | **400.8..413.6** |
| title | centred, 17sp | 17sp |
| trailing mark | ⋯ at 1290.4..1308.0 | **⋯ at 1290.4..1302.8** |
| after the ⋯ | nothing | nothing |
| composer width | 766.4 (x 490.4..1256.4) | **766.0, same edges** |
| composer card | 84.0 tall, fill (254,254,254) | — |
| empty mark | 41.2×40.8, y 373.2 | **41.6 at 373.2..414.8** |
| empty greeting | y 432.0, ink 23.2 | 435.6 |
| mark-to-greeting | 18.0 | 18.0 |
| offline block | y 776..881.6 | **792..878.8** |
| input row | y 899.2 | **898.4** |
| prose column | x 408.8..1341.6 | **409.6..1336.8** |
| prose ink | 16.8 / 17.0 / 17.2 | **16.8 / 17.2 / 17.2** |
| prose line pitch | 30.0, 29.2 | 30.0 |
| top-level • | ink 408.8..415.2, words at 421.2 | **408.8..413.6, words at 421.2** |
| nested ○ | glyph `○` at 429.2, words at 441.6 | **`○` at 429.2, words at 441.6** |
| code block | label, syntax colour, rounded plate, copy/share/more | **same shape** (positions not compared — no reference block) |

The header carries exactly three marks. It used to carry four: a laptop glyph into
settings at 1291.6 and a vertical ⋮ at 1337.6. The reference has neither — settings
is reached from the drawer, and its menu glyph is three dots in a row, not a
column.

The prose column is **not symmetric**: 48.8 in from the pane's left edge, 21.6 off
its right. Its old 40/40 came from A_claude.png, which is the reference's Code
pane, and reading that cost 8.0 on the left and 22.4 on the right.

Two numbers were re-measured this pass by cutting the left edge of seven
consecutive lines into one stacked strip, because reading glyphs one crop at a
time kept misidentifying them:

- a top-level bullet starts **at** the prose edge (408.8), not 8.8 in from it as
  the code had it, and a nested one steps 20.4;
- the body is 17.4sp, not 18 — its ink measures 17.0 against this app's 17.6.

Not yet compared on this pane: inline-code chip geometry and colour. The
reference's chips are close enough to the page colour that a pixel scan cannot
separate them from text antialiasing, so the file's existing 29.6-tall reading
stands unverified rather than re-guessed.

## 定时任务 — matched

| element | reference | this app |
|---|---|---|
| empty mark | 23.6 of ink, y 449.6 | **449.6** |
| 暂无定时任务 | y 497.2 | 498.8 |
| caption | y 526.4 | 528.8 |
| foot capsule | y 832.8, x 220.8..343.6 | 838.4, x 232.8..343.2 |

The page also had no way in at all until this pass; it has a 「+ 新建任务」 capsule
now, on the same right edge as the list pages' 新建会话.

## Dark theme — matched

Page #151515, composer card #202020, and every colour CompositionLocal carries its
own dark branch.

## Artifacts — matched

Measured against the reference with a real artifact in it. Its empty state is a
different page and cost several passes: the populated one is a bar, a search
field, then records, with nothing in between.

| element | reference | this app |
|---|---|---|
| search field | y 104.8..160.4, h 55.6 | **104.8..160.4** |
| search / card x | 16.0..343.6 | **16.0..343.6** |
| card | y 180.8..279.2, h 98.4 | 180.8..279.6, h 98.8 |
| card fill | (249,249,247) — page colour | **same** |
| thumbnail well | x 28.0..140.0, y 192.8..267.6, 112×74.8 | same size |
| well fill | (237,237,235) | **same** |
| palette sticker | 23.6 square, x 28.0..51.6 | 23.2, x 28.0..51.2 |
| title | y 197.6, x 152.8 | **197.6, x 153.6** |
| 仅您可见 | y 221.6 | **221.6** |
| 编辑于 | y 252.0 | **252.0** |

The page had a 24sp heading, two lines of blurb, a category-pill row and a
layout toggle; none of that is on the reference and all of it is gone. The card
was a three-across grid of square tiles; it is now the reference's horizontal
record.

## 设置 — list matched; surface and names still differ

The list itself now carries the reference's rhythm and its marks. Measured on
the pad after the change, against the reference's own pane:

| | reference | this app |
|---|---|---|
| label ink | 15.2 | **15.2..15.6** |
| row pitch | 58.0 | **58.0..58.8** |
| mark | 18.0 wide, x 26.8..44.8 | **18.0, x 27.6..45.6** |
| idle plate | (255,255,255) | **white** |
| gap between plates | 1.6, page ground | **1.6, page ground** |
| corner | 13.6 | **13.6** |

Two structural differences are deliberately left, because both are product
decisions rather than measurements: this app's settings is a full-screen
two-column page where the reference slides a panel over the conversation, and
its twelve names are its own rather than the reference's.

### What the reference's pane actually is

*Below:* the original reading, kept because it is what the numbers above were
taken from.



`CP-设置.png` (S3) is the reference's settings pane, captured this pass. It is
**not** a page: it is a panel that slides over the left of the conversation, which
stays visible on the right.

| | reference | this app |
|---|---|---|
| panel | white, x 12.0..347.6 (w 335.6), y 108.8 → bottom, rounded at the top only | full-screen two columns |
| page ground | (249,249,247) behind the panel | — |
| header | 设置 centred on the panel, back arrow at 15.6..32.0 | 设置 at start, no back button |
| account row | email at x 24.4, plan chip (Max) at 270.8 | none |
| rows | **12**: 个人资料 / 账单 / 用量 / 功能 / Claude Code / 连接器 / 权限 / 颜色模式 / 字体样式 / 语音 / 通知 / 时间与专注 | 12, **different names and order** |
| row icon | x 26.4..45.2 (≈18 wide), words at 58.8 | none — text only |
| row text | 58.8, ink 18.0 | 14sp, x varies |
| row pitch | 58.0 plain; 60.0 after a subtitle; 73.2 when the row below carries one | 9 vertical padding per row |
| subtitle | 已启用 4 项 at y 396.0 under 功能 | only some rows |
| divider | (221,221,221) at 165.6, under the account row | a 1 wide hairline column |

Two things this changes beyond numbers: the reference's settings **overlays** rather
than replacing the conversation, and every row carries an icon. Neither is true
here, so matching the metrics alone would still look wrong.

Row names are the reference's own; the app's 12 (`常规 / 使用情况 / 外观 / 配置 /
模型 / 个性化 / 键盘快捷键 / MCP 服务器 / 环境 / 实验室功能 / 已归档对话 /
应用更新`) are a different set from a different product surface. Mapping them is a
product decision, not a measurement.

## 项目 — matched

Its rows were bordered white plates with a folder mark, a path in 11sp and a
count on the same line. The reference's page is a list of names on the page.

Checked first: every column between the search field and the foot capsule was
scanned for a fill or a border, and there is neither - the rows are separated by
whitespace alone. Name ink 15.2 at x 24.8, second line 11.6 at the same x, the
two 22.8 apart top to top.

| | reference | before | after |
|---|---|---|---|
| name ink | 15.2 @ x 24.8 | 12.4 @ x 32.0 | **15.2 @ x 25.2** |
| second line | 11.6 @ x 24.8 | 10.0 @ x 32.0 | **11.2 @ x 25.2** |
| plate | none | white, 1dp border, 12 corner | **none** |
| folder mark | none | Ember, 20dp | **none** |

The second line carries the folder path where the reference puts an edit date it
does not expose, and the count and its menu stay because this app has data the
reference's row does not. Two line heights are stated (20.4 and 16.4) because the
defaults put 39.6 between the two tops where the reference has 22.8.

## 插件 and 连接 — no reference, so not gaps

The reference's drawer carries exactly four entries - 项目, Code, Artifacts,
定时任务 - and no plugins page. Its twelve-row settings pane has no such item
either. So this app's plugins page is **its own**, and listing it as an
uncompared screen was wrong: there is nothing on the reference to compare it to.

连接 is the same case for a different reason: it is the screen that pairs this
phone with a local MCode gateway (「连接本机的 MCode 后…」), a capability Claude's
app has no equivalent for. Neither page is scored, because neither has a
reference to be measured against.

## Not yet compared



- The diff card's **colours** (added #20A923, removed #E5351C, `@@` muted):
  still the desktop's, never sampled off the phone. The one reference thread
  that carries a step holds no file edits, so this pass had nothing to measure.
  Its **truncation** is done and tested — see below.
- The delivery card
- Code-block geometry (the reference thread has no fenced block; only its shape is
  confirmed here — label, syntax colour, plate, copy/share/more)
- (closed) The 定时任务 foot capsule read 110.4 against 122.8. Nothing was
  squeezing it: the page carried **two** capsules - one inside the empty branch,
  one at the function's foot - and both readings came off renders of that page.
  The inner one is gone, and the survivor states 122.8 by 43.6, measuring 121.6
  on the pad.
- The artifacts well carries the kind's mark where the reference shows a real
  preview thumbnail — correct for a record with nothing to render, unverified
  for one that has
- Inline-code chip geometry and colour (see the conversation pane above)
- The summary's *opening* gesture: the reference lifts a bottom sheet with a title,
  a close button and the calls inside; this app expands in place

## The tool row — matched

A run of calls folds into one summary line, and opening it gives one row per call.
Both were put beside the reference's own thread on the pad (CX2, and the sheet its
summary opens) and four things were wrong at once.

### The step's rail — removed on bad evidence, then restored

*(Corrected. An earlier pass deleted the rail outright; the paragraph below records
what it was replaced with, and why that reading was wrong.)*

A grey rule ran down the left of every step with its content inset 14, so a step's
prose started 14 right of a plain reply's. Two things were wrong there, and only
one of them was the rule.

The reference **does** have the rail: its 「Main」 thread measures one at
x 370.0..373.6, 3.6 wide, in (216,216,214) — the same width and colour the code
already had. What the earlier pass measured was CX2 and CL-MAIN, both scanned
clean down x 375..405; neither of those captures contains a single tool call, so
neither contains a step. The figure was right and the sample was empty.

What *was* wrong is where the rail sat. In one reference frame holding both a step
and a plain reply: rail 370.0, the step's bold heading 400.8, its prose 408.8, the
reply's prose also 408.8. The rail hangs 38.8 to the **left** of the prose, out in
the pane's margin, and the words do not move in for it. The code had it 1.8 in from
the content edge with a 14 inset after it — inside the text block, pushing every
word of a step to the right of a reply's.

It now draws at -37 from the content edge, measuring x 373.2 in (216,216,214) on
the pad.

The summary line carried a 23 indent as well, on a note pointing at the desktop's
`.hstep.indent` — which applies to a call nested *under* a summary, not to the
summary itself. Measured: the reference's 「已运行 2 条命令」 starts at x 401.6 with
the paragraph under it at 401.6 and a bold heading at 400.8, so all three share a
column. Ours after the change: summary 410.4, prose 410.8.

### One row, three greys

| | reference | this app |
|---|---|---|
| summary | (83,82,79) | **(83,82,79)** |
| mark | (56,56,53) | **(56,56,53)** |
| verb 「已运行」 | (19,19,19) | (31,30,28) |
| target 「Read mission…」 | (123,121,116) | **(123,121,116)** |

Every part was one muted grey, so a dozen calls read as a wall. The verb now takes
the body ink, the target a new `ToolWhat`, the mark a new `ToolMark`, and the
summary a `ToolSummary` a step darker than `InkMuted`.

### The mark was a third too small

Reference ink 15.6 by 11.6; this drew 10.4 by 10.4 from a 14 box with a 6 gap. The
slot is 15.6 with a 16 gap now, and its ink measures 11.6 high — the reference's
own number. Its width still reads 11.6 against 15.6 because the glyphs differ: a
round magnifier for a search here, a wide fork for a shell call there. Each is the
right mark for its family, so the width is left alone.

### The connector

Two rows of one group are joined by a 0.8 hairline at x 395.2..396.0 in
(216,216,214) — and 395.4 is the *mark's* centre (it spans 387.6..403.2), so the
line drops out of the icon rather than occupying a column of its own. It now does
the same here: drawn in the row's `drawBehind` at half the 15.6 slot, from below
the mark's ink to the row's bottom, skipped on a group's last row and on any row
that is not `indent`ed. On the pad it measures x 439.2..440.0 in exactly
(216,216,214).

### The words were already right

The counting drift was fixed in an earlier round and holds: `glob`/`grep` in their
own bucket, 「已搜索 N 次」, distinct paths for reads and edits, 「 · 」 between
clauses. Verified on a live turn — two globs then a read now reads 「已搜索 2 次」
then 「已读取 resources/skills/visualizer/SKILL.md」 where the old code said
「读取了 2 个文件」. Ten tests hold it (`RunSummaryTest`), and they need a real
`org.json`: the JVM test classpath stubs it.

## The +/- counter — matched

The reference's edited-files row ends in **one** object, not two labels: a green
half for additions and a pink half for deletions, meeting at a hard edge with no
gap and no divider. Sampled: 17.6 tall, halves (210,230,212) and (234,206,215),
text (76,156,73) and (212,136,160).

This app drew two bare monospace labels 6 apart in #1A7F37 / #E5484D — two
unrelated figures instead of one change with a size. `DiffCounter(add, del)` now
draws the plate with only its outer corners rounded, at both call sites (the
turn's summary and each file's row). Confirmed on the pad: 「已编辑 2 个文件」
ends in a green +12 plate.

Not settled here: the reference follows its counter with a **chevron** that opens
the file list, where this app shows that list inline. And the patch's own line
colours are still unmeasured — see below.

## The diff card — truncation fixed, colours still unmeasured

`DiffLines` drew 80 lines and dropped the rest silently. On this machine the 47
patches in the transcripts have a median of 15 lines but a maximum of 99, so a
reader could reach the bottom of a card with a third of the change behind the
fold and no sign of it. It now ends with 「…还有 N 行」.

The arithmetic is `diffSlice(diff, maxLines) -> (shown, hidden)`, a plain function
rather than part of the composable so it can be tested without a device. It reads
only `maxLines + 1` lines to decide — the first cut materialised the whole patch
just to count it. Nine tests hold it, including the 99-line case reporting 19.

## A "defect" that was my own miscount

For part of one round this file recorded that `ses_01a1505e372a` — 105 messages on
disk — rendered a single row, and called it a data fault. It is not one. Walking
the protocol against the running gateway (`session.get`) returns all 105, in order,
43 user and 62 assistant, and replaying that payload through the row rules gives
138 visible elements: 103 message rows, 33 tool rows, 2 error cards.

What happened is that the drawer held **two conversations with the same title**,
「来自手机 (分支)」, from consecutive days: 105 messages on 10-20 and one on 10-19.
I mapped the row I meant onto the wrong y, opened the one-message thread, and read
its single bubble as a broken transcript. The highlighted row in that screenshot is
the ninth, and the 105-message thread is the seventh.

The lesson is not about rendering: **same-titled siblings are the trap, and the
title is not what identifies a row.** Sort by `updated`, count from the top, and
match against the session id before concluding anything from what the pane shows.

## Locked by tests instead of by eye

91 unit tests run as part of `build.py`, all of them answerable without a device:

| class | n | what it holds down |
|---|---|---|
| `SelectionSliceTest` | 56 | the selection's offset arithmetic and hit testing |
| `MarkdownBlocksTest` | 9 | the eight block kinds and their order, list depth, table cells, fence language and body |
| `StepFoldTest` | 13 | `rowsOf` merging, `stepsOf` ownership, user turns never wrapping |
| `StepFoldRealThreadTest` | 3 | the fold replayed over a real thread's exact shape (72 parts, 33 calls) |
| `RunSummaryTest` | 10 | the summary line's five buckets, path deduplication, wording and separator |

The last of these corrected a claim rather than confirming one. The code said the
server sometimes sends calls before the prose that explains them, and that
"folding only forward left most steps unwrapped". Replaying the real thread shows
every one of its 16 call runs is preceded by assistant text; a stronger backward
fold built on that claim changed the output by nothing. The code is back to what
it was and the comment now says what the data shows.

## Recurring obstacles

- The pad locks within seconds on battery; with a PIN set, `locksettings
  set-disabled true` does not clear it and adb cannot. Every verification needs
  an unlocked screen.
- Screenshots come back black while `dumpsys power` still says Awake: automatic
  brightness pins the backlight at 0. `screen_brightness_mode 0` fixes it.
- Three devices answer adb. Only `0A06049009983540` (2272×3408) is the target.