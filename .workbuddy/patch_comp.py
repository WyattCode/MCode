p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()
old = "    Box(modifier.fillMaxWidth().padding(start = 12.dp, end = 16.dp, top = 8.dp, bottom = 16.4.dp)) {"
new = """    /*
     * 36.8 in from the pane's left, 13.2 from its right.
     *
     * The comment above says 59dp on the pad, which is what the desktop's
     * composer uses inside its own column - but this card sits in a pane that is
     * already inset, and measured on A_claude.png it runs x 396.8..1350.0 with
     * the pane starting at 360.0: 36.8 left, 13.2 right. At 12/16 the card was
     * 24.8dp wide of where the reference puts it and its left edge nearly
     * touched the column rule.
     */
    Box(modifier.fillMaxWidth().padding(start = 36.8.dp, end = 13.2.dp, top = 8.dp, bottom = 16.4.dp)) {"""
assert old in s, "composer padding not found"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("composer padding -> 36.8/13.2")
