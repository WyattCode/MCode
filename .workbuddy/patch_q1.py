import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# 1) State for the queue, filled from session.get.
old = '''    val commands = remember { mutableStateListOf<Pair<String, String>>() }'''
new = '''    val commands = remember { mutableStateListOf<Pair<String, String>>() }
    /**
     * Prompts waiting for the running turn to end, oldest first.
     *
     * The desktop keeps `SessionInfo.queued` and shows it above the composer,
     * each line withdrawable or promotable. The phone sent a queued message and
     * then lost sight of it: nothing said it had been queued, and there was no
     * way to take it back short of resetting the turn.
     */
    val queuedPrompts = remember { mutableStateListOf<Pair<String, String>>() }'''
assert old in s
s = s.replace(old, new, 1)

# 2) Fill it from the same session.get the timeline already makes.
old2 = '''            val messages = res.optJSONObject("data")?.optJSONArray("messages") ?: return@launch'''
new2 = '''            queuedPrompts.clear()
            val q = res.optJSONObject("data")?.optJSONObject("session")?.optJSONArray("queued")
            if (q != null) {
                for (k in 0 until q.length()) {
                    val item = q.optJSONObject(k) ?: continue
                    queuedPrompts.add(item.optString("id") to item.optString("text"))
                }
            }
            val messages = res.optJSONObject("data")?.optJSONArray("messages") ?: return@launch'''
assert old2 in s
s = s.replace(old2, new2, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("queue state wired")