p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """            /*
             * 49.9 and 18, measured off the reference's own wide empty pane.
             *
             * Its mark's ink runs 852.8..894.0 x 373.2..414.0 - 41.2 by 40.8 -
             * and the greeting's ink starts at 432.0, 18.0 below the mark's
             * foot. At 39.5 this drew 32.6 of ink, because a stroked star stops
             * at the radius and no spoke runs along an axis; 39.5 x 41.2/32.6
             * is 49.9.
             */
            SparkMark(Modifier.size(49.9.dp))
            Spacer(Modifier.height(18.dp))"""
new = """            /*
             * 39.5 and 18 - and 39.5 was right all along.
             *
             * Last pass I raised this to 49.9 on the theory that a 39.5 box drew
             * only 32.6 of ink, "because a stroked star stops at the radius".
             * Measured off the build at 49.9: the ink is 52.0, which scales back
             * to 41.2 at 39.5 - exactly the reference's own ink. The 32.6 was a
             * reading of a half-drawn star, not of a small one.
             *
             * The gap goes to 18: the reference's mark ends at 414.0 and its
             * greeting's ink begins at 432.0.
             */
            SparkMark(Modifier.size(39.5.dp))
            Spacer(Modifier.height(18.dp))"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("mark back to 39.5, gap 18")
