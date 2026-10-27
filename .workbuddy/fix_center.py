p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """            Column(
                Modifier.fillMaxWidth().weight(1f).padding(horizontal = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
            ) {"""
new = """            /*
             * An explicit top pad, because weight will not centre here.
             *
             * Tried three ways - `weight(1f)` with Arrangement.Center, the same
             * with fillMaxHeight, and the same with fillMaxSize - and the block
             * landed at the identical y 243.2 every time, 206 above where the
             * reference puts it. The column evidently is not being given the
             * page's height, and rather than keep guessing at what is upstream,
             * the pad states the answer: the reference's disc tops at 429.4 on a
             * 908.8 page whose header ends at 95.6, so the space above the block
             * is 333.8.
             */
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 24.dp, end = 24.dp, top = 333.8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {"""
assert old in s, "empty column"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("scheduled empty: explicit top pad 333.8")
