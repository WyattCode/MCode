p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()
old = """        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 137.6.dp, end = 124.dp, top = 10.dp, bottom = 6.dp),"""
new = """        /*
         * 40 either side, measured on the reference's Code pane.
         *
         * The 137.6/124 here came from a reading of Claude's chat pane, where
         * the text starts 99.5 dp in from a 775 dp pane. A_claude.png is the
         * Code pane - the layout this app actually mirrors, with the device
         * block and the conversation list in the left column - and its text
         * starts 40.0 dp in: 「美容师功能这一轮的实测进展：」 at x 400.0, pane edge
         * at 360.0. Reading the wrong pane cost 97 dp of measure.
         */
        contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 40.dp, end = 40.dp, top = 10.dp, bottom = 6.dp),"""
assert old in s, "padding line not found"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("padding -> 40/40")
