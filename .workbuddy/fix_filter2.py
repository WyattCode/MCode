p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old_filter = """                                MiIcon(
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
new_filter = """                                /*
                                 * Rings, not beads on a string.
                                 *
                                 * Enlarged to 5x, the reference's rings are open
                                 * circles with the rule stopping at each rim - the
                                 * axis does not run through them. Drawing one rule
                                 * and an arc over it made a figure-eight at every
                                 * ring. The rules are split around the circles now,
                                 * the circles are the reference's 4.4 dp across, and
                                 * the ink is the reference's own #383835 rather
                                 * than the muted grey this inherited from the
                                 * clock it replaced - the mark reads a step faint
                                 * beside the title.
                                 *
                                 * Measured: 16.0 x 13.6 of ink, x 280.0..295.6, and
                                 * the rings step high (3.4), low (6.6), middle (5.0).
                                 */
                                MiIcon(
                                    // left rule, split by its ring at 7.4
                                    "M5 1.6V5.2M5 9.6v12.8" +
                                        // middle rule, split by its ring at 14.2
                                        "M12 1.6v10.2M12 18.2v4.2" +
                                        // right rule, split by its ring at 10.8
                                        "M19 1.6v6.8M19 14.8v7.6" +
                                        // the three rings
                                        "M5 5.2a2.2 2.2 0 1 0 0.01 0" +
                                        "M12 14.2a2.2 2.2 0 1 0 0.01 0" +
                                        "M19 10.8a2.2 2.2 0 1 0 0.01 0",
                                    contentDescription = "筛选会话",
                                    modifier = Modifier.size(16.dp),
                                    viewBox = 24f,
                                    strokeWidth = 1.9f,
                                    tint = Color(0xFF383835),
                                )"""
assert old_filter in s
s = s.replace(old_filter, new_filter, 1)

# 列表图标同样加深
old_list = """                                MiIcon(
                                    "M2.8 5.4l1.9 1.9 3-3.6M11 5.6h10.2" +
                                        "M2.8 12.2l1.9 1.9 3-3.6M11 12.4h10.2" +
                                        "M2.8 19l1.9 1.9 3-3.6M11 19.2h10.2",
                                    contentDescription = "列表视图",
                                    modifier = Modifier.size(16.8.dp),
                                    viewBox = 24f,
                                    strokeWidth = 1.9f,
                                    tint = LocalMuted.current,
                                )"""
new_list = """                                MiIcon(
                                    "M2.8 5.4l1.9 1.9 3-3.6M11 5.6h10.2" +
                                        "M2.8 12.2l1.9 1.9 3-3.6M11 12.4h10.2" +
                                        "M2.8 19l1.9 1.9 3-3.6M11 19.2h10.2",
                                    contentDescription = "列表视图",
                                    modifier = Modifier.size(16.8.dp),
                                    viewBox = 24f,
                                    strokeWidth = 1.9f,
                                    tint = Color(0xFF383835),
                                )"""
assert old_list in s
s = s.replace(old_list, new_list, 1)

open(p, "w", encoding="utf-8").write(s)
print("filter: rings separated from rules, #383835")