import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# Remove the in-column menu.
start = '''                /*
                 * A leading slash opens the command menu, the way the desktop's
                 * composer does. Only commands whose name matches what was typed
                 * after the slash are listed, and a tap completes the name so the
                 * reader can add arguments and send as usual.
                 */
                val slash = text.trimStart()'''
end = '''                if (attachments.isNotEmpty()) {'''
i = s.index(start)
j = s.index(end, i)
s = s[:i] + s[j:]

# Put it above the card instead, as an overlay that does not disturb the layout.
old_box = '''    Box(modifier.fillMaxWidth().padding(start = 118.dp, end = 113.dp, top = 8.dp, bottom = 8.dp)) {
        Surface('''
new_box = '''    /*
     * The slash menu floats above the card rather than growing inside it: the
     * desktop's opens upward over the conversation, and pushing the field down
     * to make room moved the thing being typed away from the finger.
     */
    val slashText = text.trimStart()
    val slashMenu = if (slashText.startsWith("/") && commands.isNotEmpty() && !slashText.contains(' ')) {
        val query = slashText.drop(1)
        commands.filter { it.first.contains(query, ignoreCase = true) }.take(6)
    } else {
        emptyList()
    }
    Box(modifier.fillMaxWidth().padding(start = 118.dp, end = 113.dp, top = 8.dp, bottom = 8.dp)) {
        if (slashMenu.isNotEmpty()) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = LocalPill.current,
                shadowElevation = 6.dp,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .fillMaxWidth()
                    .offset { androidx.compose.ui.unit.IntOffset(0, -slashMenu.size * 150 - 24) },
            ) {
                Column(Modifier.padding(vertical = 4.dp)) {
                    for ((name, desc) in slashMenu) {
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable { text = "/$name " }
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("/$name", fontSize = 13.sp, color = LocalText.current)
                            if (desc.isNotBlank()) {
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    desc,
                                    fontSize = 12.sp,
                                    color = LocalMuted.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }
                    }
                }
            }
        }
        Surface('''
assert old_box in s, "composer box not found"
s = s.replace(old_box, new_box, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("menu is an overlay now")