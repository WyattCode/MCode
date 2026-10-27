p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 筛选：三根竖轴 + 三个空心圆（左高/中低/右中）
old1 = """                                /*
                                 * A funnel with three tapering rules and a dot
                                 * at each end - the reference's own filter mark,
                                 * whose dots sit high on the outer rules and low
                                 * on the middle one.
                                 */
                                MiIcon(
                                    "M9.2 3.4h5.6M7.2 8.2h9.6M9.6 13h4.8",
                                    contentDescription = "筛选会话",
                                    modifier = Modifier.size(15.6.dp),
                                    viewBox = 24f,
                                    strokeWidth = 2f,
                                    tint = LocalMuted.current,
                                )"""
new1 = """                                /*
                                 * Three verticals with a ring on each - not a
                                 * funnel.
                                 *
                                 * Enlarged from the reference's own bar: the mark
                                 * is three 2 dp rules running the full height,
                                 * each carrying a hollow ring, the rings stepping
                                 * high, low, middle left to right. A funnel reads
                                 * as "narrow this down"; this reads as sliders,
                                 * which is what the mark actually is.
                                 */
                                MiIcon(
                                    "M4.4 2.6v18.8M12 2.6v18.8M19.6 2.6v18.8" +
                                        "M4.4 8.2a2.6 2.6 0 1 0 0.01 0" +
                                        "M12 15.4a2.6 2.6 0 1 0 0.01 0" +
                                        "M19.6 11.8a2.6 2.6 0 1 0 0.01 0",
                                    contentDescription = "筛选会话",
                                    modifier = Modifier.size(15.6.dp),
                                    viewBox = 24f,
                                    strokeWidth = 1.9f,
                                    tint = LocalMuted.current,
                                )"""
assert old1 in s
s = s.replace(old1, new1, 1)

# 列表：三个对勾 + 三根横线
old2 = """                                /* Three rules with a bullet each: the list view. */
                                MiIcon(
                                    "M4.6 5.6h2.8M10.4 5.6h13M4.6 12h2.8M10.4 12h13M4.6 18.4h2.8M10.4 18.4h13",
                                    contentDescription = "列表视图",
                                    modifier = Modifier.size(16.8.dp),
                                    viewBox = 24f,
                                    strokeWidth = 1.9f,
                                    tint = LocalMuted.current,
                                )"""
new2 = """                                /*
                                 * Checks beside rules - a checklist, not bullets.
                                 *
                                 * Enlarged, the reference's rows open with a tick
                                 * (three strokes meeting at a point) rather than a
                                 * dot, which makes the mark read as "rows of a
                                 * list" instead of "items selected".
                                 */
                                MiIcon(
                                    "M2.8 5.4l1.9 1.9 3-3.6M11 5.6h10.2" +
                                        "M2.8 12.2l1.9 1.9 3-3.6M11 12.4h10.2" +
                                        "M2.8 19l1.9 1.9 3-3.6M11 19.2h10.2",
                                    contentDescription = "列表视图",
                                    modifier = Modifier.size(16.8.dp),
                                    viewBox = 24f,
                                    strokeWidth = 1.9f,
                                    tint = LocalMuted.current,
                                )"""
assert old2 in s
s = s.replace(old2, new2, 1)

open(p, "w", encoding="utf-8").write(s)
print("filter: sliders with rings; list: checks with rules")