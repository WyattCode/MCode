p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """    LazyColumn(
        modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(2.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 6.dp),
    ) {"""
new = """    LazyColumn(
        modifier.fillMaxWidth(),
        /*
         * No gap on the flat list: the reference's rows butt against each other
         * at a 60.0 pitch, so a 2 dp arrangement made every row 62.0 and every
         * title 2 low by the tenth.
         *
         * The 6.8 top is the other half of that measurement: with the rows at
         * their own height the first title landed at 167.2 where the reference
         * puts it at 174.0.
         */
        verticalArrangement = Arrangement.spacedBy(if (flat) 0.dp else 2.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            top = if (flat) 6.8.dp else 0.dp,
            bottom = 6.dp,
        ),
    ) {"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("flat list: spacing 0, top 6.8")