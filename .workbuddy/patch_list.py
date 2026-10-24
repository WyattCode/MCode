p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/Markdown.kt"
s = open(p, encoding="utf-8").read()
old = "            Row(Modifier.fillMaxWidth().padding(start = (item.depth * 16).dp, bottom = 6.dp)) {"
new = """            /*
             * 8.8 for the first level, 20.4 for each one under it.
             *
             * Measured on A_claude.png: the top-level `•` starts at 48.8 dp and
             * the nested `○` at 69.2, against a prose edge of 40.0 - so 8.8 and
             * 29.2, which is 8.8 + 20.4. The old `depth * 16` put the first
             * level flush with the prose and stacked the second only 16 in, so a
             * nested list read as the same list continued rather than as a
             * level under it.
             */
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = (8.8 + item.depth * 20.4).dp, bottom = 6.dp),
            ) {"""
assert old in s, "list row not found"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("list indent -> 8.8 + depth*20.4")
