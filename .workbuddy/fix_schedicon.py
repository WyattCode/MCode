p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 图标 20 -> 31.9（墨迹 14.8 -> 23.6），间距 14 -> 0
old = """                        modifier = Modifier.size(20.dp),
                        viewBox = 24f,
                        strokeWidth = 1.7f,
                        tint = LocalMuted.current,
                    )
                }
                Spacer(Modifier.height(14.dp))
                Text("暂无定时任务", fontSize = 15.sp, fontWeight = FontWeight.Medium, color = LocalText.current)"""
new = """                        /*
                         * 31.9, because a 20 dp box draws 14.8 of ink.
                         *
                         * The reference's clock measures 23.6 across, and a
                         * stroked ring stops at its radius, so the box has to be
                         * 20 x 23.6/14.8. Measured off the build: the mark's ink
                         * ran 14.8 in a 20 box.
                         */
                        modifier = Modifier.size(31.9.dp),
                        viewBox = 24f,
                        strokeWidth = 1.7f,
                        tint = LocalMuted.current,
                    )
                }
                /*
                 * 3.8, not 14.
                 *
                 * The reference's disc bottoms at 493.4 and its title's ink
                 * starts at 497.2. This had 14 of spacer on top of a 64 dp disc,
                 * which put 19 between them - the block read as three loose
                 * parts rather than one notice.
                 */
                Spacer(Modifier.height(3.8.dp))
                Text("暂无定时任务", fontSize = 15.sp, fontWeight = FontWeight.Medium, color = LocalText.current)"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("scheduled empty: mark 31.9, gap 3.8")
