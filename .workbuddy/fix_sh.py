p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """    Column(
        modifier.then(
            if (embedded) Modifier.fillMaxWidth()
            else Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)
        ),
    ) {
        if (!embedded) Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Box(Modifier.fillMaxWidth().height(63.2.dp)) {
            Text(
                "定时任务","""
new = """    Column(
        /*
         * fillMaxHeight, not fillMaxWidth.
         *
         * Proved with a marker that the embedded branch does run - it drew at
         * y 51.2 - so the fault is the size modifier, not the call path. With
         * fillMaxWidth the column has no height constraint of its own: the
         * caller's `weight(1f)` allocates the space, the column then measures to
         * its children, and the empty state's own `weight(1f)` finds nothing to
         * divide. The block centred at 486 on a page whose ink runs to 880.
         *
         * fillMaxHeight asks for the height the weight already granted; it does
         * not claim a second one.
         */
        modifier.then(
            if (embedded) Modifier.fillMaxHeight()
            else Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)
        ),
    ) {
        if (!embedded) Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Box(Modifier.fillMaxWidth().height(63.2.dp)) {
            Text(
                "定时任务","""
assert old in s, "scheduled modifier"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("scheduled: fillMaxHeight when embedded")
