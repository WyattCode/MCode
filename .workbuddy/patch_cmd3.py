import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''            Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
                if (attachments.isNotEmpty()) {'''

new = '''            Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
                /*
                 * A leading slash opens the command menu, the way the desktop's
                 * composer does. Only commands whose name matches what was typed
                 * after the slash are listed, and a tap completes the name so the
                 * reader can add arguments and send as usual.
                 */
                val slash = text.trimStart()
                val menu = if (slash.startsWith("/") && commands.isNotEmpty()) {
                    val query = slash.drop(1).substringBefore(' ')
                    commands.filter { it.first.contains(query, ignoreCase = true) }.take(6)
                } else {
                    emptyList()
                }
                if (menu.isNotEmpty() && !slash.contains(' ')) {
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = LocalPill.current,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp),
                    ) {
                        Column(Modifier.padding(vertical = 4.dp)) {
                            for ((name, desc) in menu) {
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clickable { text = "/$name " }
                                        .padding(horizontal = 12.dp, vertical = 7.dp),
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
                if (attachments.isNotEmpty()) {'''

assert old in s, "composer column not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("slash menu added")