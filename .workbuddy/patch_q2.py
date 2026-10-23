import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''            commands = commands.toList(),'''
new = '''            commands = commands.toList(),
            queued = queuedPrompts.toList(),
            onQueueRemove = { id ->
                queuedPrompts.removeAll { it.first == id }
                request(JSONObject().put("type", "session.queue.remove").put("sessionID", currentSession!!).put("id", id))
            },
            onQueueSend = { id ->
                request(JSONObject().put("type", "session.queue.send").put("sessionID", currentSession!!).put("id", id))
            },'''
assert old in s
s = s.replace(old, new, 1)

old2 = '''listening: Boolean = false, transcribing: Boolean = false, commands: List<Pair<String, String>> = emptyList()) {'''
new2 = '''listening: Boolean = false, transcribing: Boolean = false, commands: List<Pair<String, String>> = emptyList(), queued: List<Pair<String, String>> = emptyList(), onQueueRemove: (String) -> Unit = {}, onQueueSend: (String) -> Unit = {}) {'''
assert old2 in s
s = s.replace(old2, new2, 1)

# Render above the card, first in the column.
old3 = '''            Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
                if (attachments.isNotEmpty()) {'''
new3 = '''            Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
                /*
                 * Queued prompts, oldest first, above the field: a line each with
                 * the words, a send-now arrow and an × to withdraw. The desktop
                 * shows them the same way, and without them a message typed
                 * during a turn looked swallowed.
                 */
                if (queued.isNotEmpty()) {
                    Column(Modifier.padding(bottom = 6.dp)) {
                        for ((id, words) in queued) {
                            Row(
                                Modifier.fillMaxWidth().padding(vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    words,
                                    fontSize = 13.sp,
                                    color = LocalMuted.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                Box(
                                    Modifier.size(28.dp).clickable { onQueueSend(id) },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(Icons.Filled.ArrowUpward, contentDescription = "立即发送", tint = LocalMuted.current, modifier = Modifier.size(15.dp))
                                }
                                Box(
                                    Modifier.size(28.dp).clickable { onQueueRemove(id) },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(Icons.Outlined.Close, contentDescription = "撤回", tint = LocalMuted.current, modifier = Modifier.size(15.dp))
                                }
                            }
                        }
                    }
                }
                if (attachments.isNotEmpty()) {'''
assert old3 in s
s = s.replace(old3, new3, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("queue rendered")