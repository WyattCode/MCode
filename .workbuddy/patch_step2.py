import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# 1) Fold into steps.
old = '''    val rows = remember(items.toList()) { rowsOf(items) }'''
new = '''    val rows = remember(items.toList()) { stepsOf(rowsOf(items)) }'''
assert old in s
s = s.replace(old, new, 1)

# 2) Key lookup musn't blow up on Step.
old2 = '''            item(key = (item as? ToolRun)?.key ?: (item as Item).key) {'''
new2 = '''            item(key = (item as? ToolRun)?.key ?: (item as? Step)?.key ?: (item as Item).key) {'''
assert old2 in s, "key line not found"
s = s.replace(old2, new2, 1)

# 3) Render a step: rule on the left, body and calls on the right.
old3 = '''                when (item) {
                    is Item.Msg -> {'''
new3 = '''                when (item) {
                    /*
                     * A step: the rule down the left, then the words and the
                     * calls it made inside it. The rule is the only thing that
                     * says those rows belong together.
                     */
                    is Step -> Row(Modifier.fillMaxWidth()) {
                        Box(
                            Modifier
                                .padding(end = 10.dp, top = 6.dp, bottom = 2.dp)
                                .width(3.5.dp)
                                .matchParentSize()
                                .width(3.5.dp)
                                .background(
                                    if (LocalBg.current == DarkBg) Color(0xFF3A3A38) else Color(0xFFD8D8D6),
                                    RoundedCornerShape(2.dp),
                                ),
                        )
                        Column(Modifier.weight(1f)) {
                            (item.body as? Item.Msg)?.let { StepBody(it) }
                            for (call in item.calls) {
                                when (call) {
                                    is Item.Tool -> ToolRow(call)
                                    is ToolRun -> RunRow(call)
                                }
                            }
                        }
                    }
                    is Item.Msg -> {'''
assert old3 in s, "when(item) anchor not found"
s = s.replace(old3, new3, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("step rendering wired")