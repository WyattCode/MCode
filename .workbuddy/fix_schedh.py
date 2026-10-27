p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """        modifier.then(
            if (embedded) Modifier.fillMaxWidth()
            else Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)
        ),"""
new = """        /*
         * fillMaxSize in both cases - the caller's weight supplies the height.
         *
         * Stripping it to fillMaxWidth when embedded looked like the fix for the
         * double-constraint problem, and made the page worse: with no height
         * constraint the column measured to its children, so the empty state's
         * `weight(1f)` had nothing to divide and the block sat at the column's
         * own top - the clock at y 219.2 where the reference puts it at 449.6.
         *
         * `weight` already gives this node a bounded height; fillMaxSize inside
         * that bound is not a second opinion, it is the same number.
         */
        modifier.then(Modifier.fillMaxSize())
            .then(if (embedded) Modifier else Modifier.background(MaterialTheme.colorScheme.background)),"""
assert old in s, "sched height"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("scheduled: fillMaxSize with background conditional")
