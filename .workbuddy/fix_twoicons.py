p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) 笔记本图标（进设置）删掉——Claude 右栏顶栏右侧只有一个 ⋯
old1 = """                            Box(Modifier.size(40.dp).clickable { leftMode = LeftMode.Settings }, contentAlignment = Alignment.Center) {
                                MiIcon(
                                    "M5.6 7.4h12.8a1.2 1.2 0 0 1 1.2 1.2v7.4H4.4V8.6a1.2 1.2 0 0 1 1.2-1.2zM3.2 16h17.6v2a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1z",
                                    contentDescription = "Code",
                                    modifier = Modifier.size(19.2.dp),
                                    viewBox = 24f,
                                    strokeWidth = 1.7f,
                                    tint = LocalText.current,
                                )
                            }"""
new1 = """                            /*
                             * One trailing mark, as the reference has.
                             *
                             * Its conversation header's right end holds a single
                             * ⋯ at x 1290.4..1308.0 and nothing after it. This
                             * carried two: a laptop glyph at 1291.6 (the way into
                             * settings) and a ⋮ at 1337.6. Settings keeps its route
                             * through the drawer; the header does not need a second
                             * mark competing with the overflow.
                             */"""
assert old1 in s, "laptop icon"
s = s.replace(old1, new1, 1)

# 2) ⋮ -> ⋯，Claude 用的是横排三点
old2 = """                                Icon(Icons.Outlined.MoreVert, contentDescription = "更多", tint = LocalText.current, modifier = Modifier.size(20.dp))"""
new2 = """                                /*
                                 * Horizontal dots, not vertical.
                                 *
                                 * Enlarged from the reference's header: its mark
                                 * is three dots in a row, ⋯, at 1290.4..1308.0.
                                 * This drew ⋮ - the same menu, a different glyph,
                                 * and the only visible difference at this size
                                 * between the two headers' right ends.
                                 */
                                Canvas(Modifier.size(18.4.dp)) {
                                    val r = 1.9f * density
                                    val cy = size.height / 2f
                                    val gap = size.width / 4f
                                    drawCircle(Color(0xFF1F1E1C), radius = r, center = androidx.compose.ui.geometry.Offset(gap, cy))
                                    drawCircle(Color(0xFF1F1E1C), radius = r, center = androidx.compose.ui.geometry.Offset(gap * 2f, cy))
                                    drawCircle(Color(0xFF1F1E1C), radius = r, center = androidx.compose.ui.geometry.Offset(gap * 3f, cy))
                                }"""
assert old2 in s, "morevert"
s = s.replace(old2, new2, 1)

open(p, "w", encoding="utf-8").write(s)
print("header right: one mark, and it is horiz dots")
