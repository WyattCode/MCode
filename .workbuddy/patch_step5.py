import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# Draw the rail with a Canvas behind the content instead of a sibling Box:
# a Box in a Row sizes to its own content, and content-based height is zero.
old = '''                    is Step -> Row(
                        Modifier.fillMaxWidth().height(IntrinsicSize.Min),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Box(
                            Modifier
                                .padding(end = 10.dp, top = 6.dp, bottom = 2.dp)
                                .fillMaxHeight()
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
                    }'''

new = '''                    is Step -> {
                        /*
                         * The rule is drawn behind the content, not beside it:
                         * a Box in a Row sizes to its own content, and a rule
                         * with no content of its own measured zero - which is
                         * why the first attempt showed nothing at all.
                         */
                        val rail = if (LocalBg.current == DarkBg) Color(0xFF3A3A38) else Color(0xFFD8D8D6)
                        Box(Modifier.fillMaxWidth()) {
                            Canvas(Modifier.matchParentSize()) {
                                val x = 1.8.dp.toPx()
                                drawLine(
                                    color = rail,
                                    start = androidx.compose.ui.geometry.Offset(x, 4.dp.toPx()),
                                    end = androidx.compose.ui.geometry.Offset(x, size.height - 4.dp.toPx()),
                                    strokeWidth = 3.5.dp.toPx(),
                                    cap = androidx.compose.ui.graphics.StrokeCap.Round,
                                )
                            }
                            Column(Modifier.fillMaxWidth().padding(start = 14.dp)) {
                                (item.body as? Item.Msg)?.let { StepBody(it) }
                                for (call in item.calls) {
                                    when (call) {
                                        is Item.Tool -> ToolRow(call)
                                        is ToolRun -> RunRow(call)
                                    }
                                }
                            }
                        }
                    }'''

assert old in s, "step block not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("rail drawn as canvas")