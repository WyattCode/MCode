p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                            /*
                             * Against the column's right edge, not centred.
                             *
                             * Measured: the capsule runs x=552..859 in a column
                             * that ends at 925, so it sits 26.4 dp off the seam
                             * and 220.8 off the left edge. Centred put it 105 dp
                             * too far left and made the column read as empty on
                             * the side the thumb reaches for.
                             */
                            modifier = Modifier.align(Alignment.End).padding(end = 26.4.dp),"""

new = """                            /*
                             * Against the column's right edge, 16.4 off it.
                             *
                             * Re-measured on the reference's own column, which is
                             * 900 px wide, not 925: its capsule runs
                             * x 552.0..859.0, i.e. 16.4 dp from the seam. The
                             * 26.4 here came from measuring against 925 - a
                             * width this column never has - and put the button
                             * 10 dp inboard of where the reference sits.
                             */
                            modifier = Modifier.align(Alignment.End).padding(end = 16.4.dp),"""

assert old in s, "foot capsule padding not found"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("foot capsule: end 26.4 -> 16.4")