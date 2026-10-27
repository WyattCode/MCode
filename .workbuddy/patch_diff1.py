import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# 1) State.
old = '''    var filePreview by remember { mutableStateOf<Pair<String, String>?>(null) }'''
new = '''    var filePreview by remember { mutableStateOf<Pair<String, String>?>(null) }
    /**
     * The changes rail: which files a turn touched, and the patch for the one
     * being read. The desktop keeps this beside the conversation all the time;
     * on a phone it belongs in a sheet reached from the header.
     */
    var showChanges by remember { mutableStateOf(false) }
    val changedFiles = remember { mutableStateListOf<String>() }
    var changePatch by remember { mutableStateOf<Pair<String, String>?>(null) }
    var changeBranch by remember { mutableStateOf("") }'''
assert old in s
s = s.replace(old, new, 1)

# 2) Menu entry.
old2 = '''                                    DropdownMenuItem(
                                        text = { Text("\u9879\u76ee\u6587\u4ef6") },
                                        onClick = { headerMenu = false; showFiles = true; fileStack = listOf("") },
                                    )'''
new2 = '''                                    DropdownMenuItem(
                                        text = { Text("\u9879\u76ee\u6587\u4ef6") },
                                        onClick = { headerMenu = false; showFiles = true; fileStack = listOf("") },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("\u672c\u6b21\u6539\u52a8") },
                                        onClick = { headerMenu = false; showChanges = true },
                                    )'''
assert old2 in s, "files menu item not found"
s = s.replace(old2, new2, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("changes state + menu")