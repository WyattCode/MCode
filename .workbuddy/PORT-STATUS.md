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

The header carries exactly three marks. It used to carry four: a laptop glyph into
settings at 1291.6 and a vertical ⋮ at 1337.6. The reference has neither — settings
is reached from the drawer, and its menu glyph is three dots in a row, not a
column.

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

## Not yet compared

- Artifacts page (the shot filed as CL-ART.png was actually Code — the tap missed)
- Rich message bodies: tool rows, code blocks, the diff and delivery cards
- The 定时任务 foot capsule is 110.4 wide against 122.8, and the twelve come from a
  squeeze I have not located

## Recurring obstacles

- The pad locks within seconds on battery; with a PIN set, `locksettings
  set-disabled true` does not clear it and adb cannot. Every verification needs
  an unlocked screen.
- Screenshots come back black while `dumpsys power` still says Awake: automatic
  brightness pins the backlight at 0. `screen_brightness_mode 0` fixes it.
- Three devices answer adb. Only `0A06049009983540` (2272×3408) is the target.