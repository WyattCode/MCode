p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """    if (leftMode == LeftMode.Projects) {
        ProjectsScreen(
            rows = projectRows,"""
new = """    /*
     * 项目 is drawn twice on the pad: here, and again inside the split layout's
     * left column. This branch had no width guard, so on the pad it painted a
     * full-screen copy - with its own status-bar spacer, which pushed the header
     * 32.8 down - and then the wide branch painted the real one over the top.
     * The visible result was a header showing its burger and nothing else, and
     * card rows starting at y 152 where the reference starts them at 282.
     *
     * Guarded the way 设置 is below: this runs only when the wide branch will not
     * draw the page itself.
     */
    if (leftMode == LeftMode.Projects && widthSize < Expanded) {
        ProjectsScreen(
            rows = projectRows,"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("narrow projects branch: width guard added")
