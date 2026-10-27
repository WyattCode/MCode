p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                        contentAlignment = if (compact) Alignment.TopStart else Alignment.Center,"""
new = """                        /*
                         * Top on the flat rows.
                         *
                         * The mark hangs at the start of the title's line; a
                         * centred box put it 15 dp below the text it belongs to
                         * - measured, the mark's ink at y 190.0 while the title
                         * began at 175.2. Centre is right for the cards, where
                         * the mark sits against a two-line block.
                         */
                        contentAlignment = when {
                            compact -> Alignment.TopStart
                            flat -> Alignment.Top
                            else -> Alignment.Center
                        },"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("flat icon: Top, not Center")