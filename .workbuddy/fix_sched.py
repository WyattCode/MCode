p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) embedded 时不要 fillMaxSize（调用方已给 weight(1f)，两个尺寸约束打架）
old1 = """    Column(
        modifier.then(if (embedded) Modifier.fillMaxSize() else Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)),
    ) {
        if (!embedded) Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Box(Modifier.fillMaxWidth().height(63.2.dp)) {
            Text("""
new1 = """    /*
     * fillMaxWidth when embedded - never fillMaxSize over the caller's weight.
     *
     * Same fault as 项目 and 设置: the wide layout hands these pages
     * `Modifier.weight(1f)` inside a Column, and wrapping that in fillMaxSize
     * gives one node two size constraints. The layout resolved it by halving the
     * page, so the empty block centred on 486 instead of 908 and its clock landed
     * at y 243 where the reference puts it at 449.6.
     */
    Column(
        modifier.then(
            if (embedded) Modifier.fillMaxWidth()
            else Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)
        ),
    ) {
        if (!embedded) Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Box(Modifier.fillMaxWidth().height(63.2.dp)) {
            Text("""
assert old1 in s, "scheduled column"
s = s.replace(old1, new1, 1)

open(p, "w", encoding="utf-8").write(s)
print("scheduled: fillMaxWidth when embedded")
