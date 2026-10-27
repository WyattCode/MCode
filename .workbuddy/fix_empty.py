p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 宽屏空态：图标 39.5 -> 49.9, 间距 14 -> 18
old = """            SparkMark(Modifier.size(39.5.dp))
            Spacer(Modifier.height(14.dp))
            Text(greeting(), fontSize = 18.sp, fontWeight = FontWeight.Normal, color = LocalText.current)
        } else {"""
new = """            /*
             * 49.9 and 18, measured off the reference's own wide empty pane.
             *
             * Its mark's ink runs 852.8..894.0 x 373.2..414.0 - 41.2 by 40.8 -
             * and the greeting's ink starts at 432.0, 18.0 below the mark's
             * foot. At 39.5 this drew 32.6 of ink, because a stroked star stops
             * at the radius and no spoke runs along an axis; 39.5 x 41.2/32.6
             * is 49.9.
             */
            SparkMark(Modifier.size(49.9.dp))
            Spacer(Modifier.height(18.dp))
            Text(greeting(), fontSize = 18.sp, fontWeight = FontWeight.Normal, color = LocalText.current)
        } else {"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("wide empty pane: mark 49.9, gap 18")