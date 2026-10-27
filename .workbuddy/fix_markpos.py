p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = "                            .offset(y = if (compact) (-6.4).dp else 0.dp),"
new = """                            /*
                             * The flat row's mark sits 6 right and 13.6 up.
                             *
                             * Measured against the reference's own first row: its
                             * mark's ink runs x 26.0..37.6 with the row's first
                             * line at y 174.0. This drew it at 20.0 and 187.6 -
                             * left of the title's own left edge and a line low,
                             * which read as a bullet beside the text rather than
                             * a mark on it.
                             */
                            .offset(
                                x = if (flat) 6.dp else 0.dp,
                                y = when {
                                    compact -> (-6.4).dp
                                    flat -> (-13.6).dp
                                    else -> 0.dp
                                },
                            ),"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("flat mark: +6 x, -13.6 y")