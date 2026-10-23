import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# 1) App state: the command list, loaded once per session.
old = '''    /** Bumped when the reader taps the conversation's title; the timeline obeys. */
    var toTopTicks by remember { mutableStateOf(0) }'''
new = '''    /** Bumped when the reader taps the conversation's title; the timeline obeys. */
    var toTopTicks by remember { mutableStateOf(0) }
    /**
     * The slash commands this folder offers.
     *
     * The desktop reads them from `command.list` and opens a filtered menu when
     * the box starts with `/`; the phone had no way to reach them at all, so a
     * command that exists everywhere else on the product was untypable here.
     */
    val commands = remember { mutableStateListOf<Pair<String, String>>() }'''
assert old in s
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("state added")