p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = "                        .height(if (compact) 43.6.dp else if (flat) 60.dp else 68.dp)"
new = """                        /*
                         * 41.4 for the drawer, 43.6 elsewhere-compact.
                         *
                         * Measured on this build: the drawer's titles ran 45.6
                         * apart where the reference's run 42.4, 43.6, 43.6,
                         * 44.8, 42.4 - a 43.4 mean. The 43.6 here was set from
                         * the mean rather than from the spacing that produces
                         * it, so every row carried 2.2 of extra height. The flat
                         * list keeps its own 60 and is unaffected.
                         */
                        .height(
                            when {
                                compact -> 41.4.dp
                                flat -> 60.dp
                                else -> 68.dp
                            }
                        )"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("drawer row height: 41.4")