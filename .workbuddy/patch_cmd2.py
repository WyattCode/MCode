import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# Load commands once the session's folder is known.
old = '''    val inputBar: @Composable () -> Unit = {
        InputCapsule('''
new = '''    // The folder decides which commands exist, so this follows the session.
    val commandDir = sessions.find { it.id == currentSession }?.directory.orEmpty()
    LaunchedEffect(commandDir) {
        commands.clear()
        val ticket = "cmd${System.nanoTime()}"
        val deferred = client.awaitResponse(ticket)
        request(JSONObject().put("type", "command.list").put("directory", commandDir), ticket)
        val res = runCatching { deferred.await() }.getOrNull() ?: return@LaunchedEffect
        val arr = res.optJSONObject("data")?.optJSONArray("commands") ?: return@LaunchedEffect
        for (i in 0 until arr.length()) {
            val c = arr.optJSONObject(i) ?: continue
            val name = c.optString("name")
            if (name.isNotBlank()) commands.add(name to c.optString("description", ""))
        }
    }

    val inputBar: @Composable () -> Unit = {
        InputCapsule('''
assert old in s
s = s.replace(old, new, 1)

# Pass them down.
old2 = '''            onRemoveAttachment = { attachments.removeAt(it) },
            pickImages = { pickImages() },'''
new2 = '''            onRemoveAttachment = { attachments.removeAt(it) },
            pickImages = { pickImages() },
            commands = commands.toList(),'''
assert old2 in s
s = s.replace(old2, new2, 1)

# Signature.
old3 = '''onRemoveAttachment: (Int) -> Unit = {}, listening: Boolean = false, transcribing: Boolean = false) {'''
new3 = '''onRemoveAttachment: (Int) -> Unit = {}, listening: Boolean = false, transcribing: Boolean = false, commands: List<Pair<String, String>> = emptyList()) {'''
assert old3 in s
s = s.replace(old3, new3, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("command.list wired")