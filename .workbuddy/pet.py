import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# 1) State.
old = '''    var showScheduled by remember { mutableStateOf(false) }'''
if old not in s:
    # find the declaration
    import re
    m = re.search(r'\n(\s*)var showScheduled by remember \{ mutableStateOf\(false\) \}', s)
    old = m.group(0).strip()
    indent = m.group(1)
else:
    indent = "    "

new = old + '''
    /**
     * The scheduled tasks the server pushes as `automation.tasks`.
     *
     * The page used to say "MCode has no scheduled tasks yet" as a permanent
     * sentence, which was a guess: the server has had them all along and simply
     * broadcasts them to whoever is listening.
     */
    val automations = remember { mutableStateListOf<Triple<String, String, Long>>() }'''
s = s.replace(old, new, 1)

# 2) Listen for the event.
old2 = '''                    "session.deleted" -> {'''
new2 = '''                    "automation.tasks" -> {
                        automations.clear()
                        val arr = event.optJSONArray("tasks") ?: return
                        for (i in 0 until arr.length()) {
                            val t = arr.optJSONObject(i) ?: continue
                            automations.add(
                                Triple(
                                    t.optString("id"),
                                    t.optString("title"),
                                    t.optLong("nextAt", 0L),
                                ),
                            )
                        }
                    }
                    "session.deleted" -> {'''
assert old2 in s, "event dispatch anchor not found"
s = s.replace(old2, new2, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("automations state + event")