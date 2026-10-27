import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# 1) State.
old = '''    val queuedPrompts = remember { mutableStateListOf<Pair<String, String>>() }'''
new = '''    val queuedPrompts = remember { mutableStateListOf<Pair<String, String>>() }
    /**
     * Whether the session lets the app choose the model ("Smart" on the
     * desktop's model pill). It changes what the pill says, and it is the
     * default way a conversation is run, so the phone should say it too.
     */
    var smartMode by remember { mutableStateOf(false) }'''
assert old in s
s = s.replace(old, new, 1)

# 2) Read it alongside the queue.
old2 = '''            val q = res.optJSONObject("data")?.optJSONObject("session")?.optJSONArray("queued")'''
new2 = '''            smartMode = res.optJSONObject("data")?.optJSONObject("session")?.optBoolean("smart") ?: false
            val q = res.optJSONObject("data")?.optJSONObject("session")?.optJSONArray("queued")'''
assert old2 in s
s = s.replace(old2, new2, 1)

# 3) The pill reads it.
old3 = '''    val currentModelLabel = if (effortLabel.isNotEmpty()) "$displayModel $effortLabel" else displayModel'''
new3 = '''    // "Smart" replaces the model's name when the session lets the app pick one,
    // which is what the desktop's pill does.
    val shownModel = if (smartMode) "Smart" else displayModel
    val currentModelLabel = if (effortLabel.isNotEmpty()) "$shownModel $effortLabel" else shownModel'''
assert old3 in s
s = s.replace(old3, new3, 1)

io.open(path, "w", encoding="utf-8").write(s)
print("smart pill wired")