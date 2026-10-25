p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = "        Column(Modifier.fillMaxWidth()) {"
new = """        /*
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
assert old in s, "composer column"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("composer: 130.4 / 106.8 insets")