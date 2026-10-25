p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()
# 去掉标记，改 modifier：不再叠加 fillMaxSize
old = """        if (embedded) Text("EMB", fontSize = 40.sp, color = Color(0xFFFF00FF))
"""
assert old in s
s = s.replace(old, "", 1)

old2 = """        modifier.then(Modifier.fillMaxSize())
            .then(if (embedded) Modifier else Modifier.background(MaterialTheme.colorScheme.background)),"""
new2 = """        /*
         * The caller's modifier already carries weight(1f) - a bounded height.
         * Adding fillMaxSize on top of a weight is what halved the page: measured,
         * the column's content started at 32.8 (correct) and the empty block
         * centred at 486, so the column believed it was 972 tall on an 880 page.
         */
        modifier,
    ) {"""
if old2 not in s:
    old2 = """        modifier.then(Modifier.fillMaxSize())
            .then(if (embedded) Modifier else Modifier.background(MaterialTheme.colorScheme.background)),
    ) {"""
assert old2 in s, "modifier block"
s = s.replace(old2, new2, 1)
open(p, "w", encoding="utf-8").write(s)
print("marker removed; modifier is the caller's alone")
