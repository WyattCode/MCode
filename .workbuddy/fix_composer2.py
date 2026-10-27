p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """            shadowElevation = if (LocalBg.current == DarkBg) 2.dp else 4.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {"""
new = """            shadowElevation = if (LocalBg.current == DarkBg) 2.dp else 4.dp,
            /*
             * 766.4 inside a 1003.2 pane, centred: 130.4 left, 106.8 right.
             *
             * Measured on the reference's own conversation - its composer's
             * white card runs x 490.4..1256.4. This filled the pane minus 12 of
             * padding, so the card ran 951.6 wide with its right edge 14.4 from
             * the seam where the reference leaves a tenth of the screen empty.
             * The composer's width is what makes the transcript read as a column
             * rather than as a wall, and it is the last thing on the page to
             * look wrong when everything else has been matched.
             */
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 130.4.dp, end = 106.8.dp),
        ) {"""
assert old in s, "composer surface"
s = s.replace(old, new, 1)

# 撤回上一次改错位置的那处
old2 = """        /*
         * A 766.4 card, centred - not the pane's full width.
         *
         * Measured on the reference's own conversation: its composer's white
         * card runs x 490.4..1256.4, which is 766.4 wide inside a 1003.2 pane,
         * leaving 130.4 on the left and 106.8 on the right. This filled the pane
         * minus 12 of padding, so the card ran 951.6 wide and its right edge sat
         * 14.4 from the seam where the reference leaves a tenth of the screen
         * empty. The composer is the narrowest thing on the page and it is what
         * makes the transcript look like a column rather than a wall.
         */
        Column(Modifier.fillMaxWidth().padding(start = 130.4.dp, end = 106.8.dp)) {"""
new2 = """        Column(Modifier.fillMaxWidth()) {"""
if old2 in s:
    s = s.replace(old2, new2, 1)
    print("reverted the mis-targeted inset")

open(p, "w", encoding="utf-8").write(s)
print("composer surface: 130.4 / 106.8")