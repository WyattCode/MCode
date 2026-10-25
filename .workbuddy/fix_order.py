p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                        /* 1.6 on the flat list: measured, the mark sits at 26.0 and the row draws its icon column inside this padding. */
                        .padding(horizontal = if (compact) 6.dp else if (flat) 1.6.dp else 12.dp, vertical = if (compact) 0.dp else 5.dp)
                        /*
                         * 60.0 on the flat list.
                         *
                         * Measured: one row of Claude's 最近记录 runs from its
                         * title's ink at 174.0 to the next title's at 234.0.
                         * The 68 here is the cards' height, and on the flat rows
                         * it left 80.4 between titles - the home list read as
                         * half as long as the reference's.
                         */
                        .height(if (compact) 43.6.dp else if (flat) 60.dp else 68.dp)"""

new = """                        /*
                         * Height before inset.
                         *
                         * `height` sizes what it wraps, so with the vertical
                         * padding applied first the row measured 60 + 5 + 5 = 70
                         * and the titles ran 72.4 apart where the reference's
                         * run 60.0. Stated first, the 60 is the row's own.
                         */
                        .height(if (compact) 43.6.dp else if (flat) 60.dp else 68.dp)
                        /*
                         * 1.6 on the flat list: measured, the mark sits at 26.0
                         * and the row draws its icon column inside this inset.
                         */
                        .padding(horizontal = if (compact) 6.dp else if (flat) 1.6.dp else 12.dp, vertical = if (compact) 0.dp else 5.dp)"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("height before padding")