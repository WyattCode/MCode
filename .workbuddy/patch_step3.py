import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# Fix the conflicting modifiers on the rule.
old = '''                            Modifier
                                .padding(end = 10.dp, top = 6.dp, bottom = 2.dp)
                                .width(3.5.dp)
                                .matchParentSize()
                                .width(3.5.dp)
                                .background('''
new = '''                            Modifier
                                .padding(end = 10.dp, top = 6.dp, bottom = 2.dp)
                                .fillMaxHeight()
                                .width(3.5.dp)
                                .background('''
assert old in s
s = s.replace(old, new, 1)

# The row needs a fixed alignment so the rule can stretch.
old2 = '''                    is Step -> Row(Modifier.fillMaxWidth()) {'''
new2 = '''                    is Step -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {'''
assert old2 in s
s = s.replace(old2, new2, 1)

# StepBody + RunRow, next to ToolRow.
anchor = '''@Composable
fun ToolRow(item: Item.Tool) {'''
helper = '''/** The words of a step. Split out so a step and a bare reply draw them alike. */
@Composable
private fun StepBody(item: Item.Msg) {
    if (item.text.isBlank()) return
    Box(Modifier.fillMaxWidth()) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 5.dp),
        ) {
            MarkdownBody(item.text, dark = LocalBg.current == DarkBg)
        }
    }
}

/** A folded run inside a step: the same summary row the timeline draws. */
@Composable
private fun RunRow(item: ToolRun) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.padding(start = 10.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                runSummary(item),
                fontSize = 12.5.sp,
                color = LocalMuted.current,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = if (open) "\u6536\u8d77" else "\u5c55\u5f00",
                tint = LocalMuted.current,
                modifier = Modifier.size(14.dp).graphicsLayer { rotationZ = if (open) 90f else 0f },
            )
        }
        if (open) for (call in item.items) ToolRow(call)
    }
}

'''
assert anchor in s, "ToolRow anchor not found"
s = s.replace(anchor, helper + anchor, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("StepBody + RunRow added")