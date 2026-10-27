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

## Not yet compared

- Rich message bodies: tool rows, the diff and delivery cards
- Code-block geometry (the reference thread has no fenced block; only its shape is
  confirmed here — label, syntax colour, plate, copy/share/more)
- The 定时任务 foot capsule is 110.4 wide against 122.8, and the twelve come from a
  squeeze I have not located
- The artifacts well carries the kind's mark where the reference shows a real
  preview thumbnail — correct for a record with nothing to render, unverified
  for one that has
- Inline-code chip geometry and colour (see the conversation pane above)

## Known defect, not fixed

The thread `ses_01a1505e372a` holds 105 messages in storage and renders **one row**
in this app: it opens, the header names it, one user bubble appears, and nothing
follows. That is a data fault rather than a cosmetic one — the gateway's payload
and what the phone keeps need comparing before anything is changed.

## Locked by tests instead of by eye

81 unit tests run as part of `build.py`, all of them answerable without a device:

| class | n | what it holds down |
|---|---|---|
| `SelectionSliceTest` | 56 | the selection's offset arithmetic and hit testing |
| `MarkdownBlocksTest` | 9 | the eight block kinds and their order, list depth, table cells, fence language and body |
| `StepFoldTest` | 13 | `rowsOf` merging, `stepsOf` ownership, user turns never wrapping |
| `StepFoldRealThreadTest` | 3 | the fold replayed over a real thread's exact shape (72 parts, 33 calls) |

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