import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# 1) Panel state next to the others.
old = '''    var showUsage by remember { mutableStateOf(false) }'''
new = '''    var showUsage by remember { mutableStateOf(false) }
    /**
     * The project browser.
     *
     * The desktop keeps a whole right-hand rail - files, changes, review,
     * subagents, terminal, version history - and a tablet has the room for at
     * least the first of them. `root` is the folder being listed, `sub` the
     * path inside it, and `path` the stack of crumbs walked down.
     */
    var showFiles by remember { mutableStateOf(false) }
    var fileStack by remember { mutableStateOf(listOf("")) }
    val fileEntries = remember { mutableStateListOf<Pair<String, Boolean>>() }
    var filePreview by remember { mutableStateOf<Pair<String, String>?>(null) }'''
assert old in s
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("file browser state")