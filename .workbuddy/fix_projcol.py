p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """    Column(
        modifier.then(if (embedded) Modifier.fillMaxSize() else Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)),
    ) {"""
new = """    /*
     * No fillMaxSize on top of the caller's modifier.
     *
     * The wide layout hands this page `Modifier.weight(1f).fillMaxWidth()` inside
     * a Column, and this wrapped that in another `fillMaxSize()`. Two size
     * constraints on the same node is a conflict the layout resolves by giving
     * the page a height its children cannot measure against: the header's Box
     * drew its burger and nothing else - no title, no search, no filter, though
     * all three are in the code and all three draw on the home page.
     *
     * When the page is not embedded it owns the screen and asks for it plainly.
     */
    Column(
        modifier.then(
            if (embedded) Modifier.fillMaxWidth()
            else Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)
        ),
    ) {"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("projects column: fillMaxWidth when embedded")