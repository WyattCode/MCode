import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# 1) Menu entry, after 只看运行中.
old = '''                                    DropdownMenuItem(
                                        text = { Text(if (runningOnly) "\u663e\u793a\u5168\u90e8\u4f1a\u8bdd" else "\u53ea\u770b\u8fd0\u884c\u4e2d") },
                                        onClick = { headerMenu = false; runningOnly = !runningOnly },
                                    )'''
new = '''                                    DropdownMenuItem(
                                        text = { Text(if (runningOnly) "\u663e\u793a\u5168\u90e8\u4f1a\u8bdd" else "\u53ea\u770b\u8fd0\u884c\u4e2d") },
                                        onClick = { headerMenu = false; runningOnly = !runningOnly },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("\u9879\u76ee\u6587\u4ef6") },
                                        onClick = { headerMenu = false; showFiles = true; fileStack = listOf("") },
                                    )'''
assert old in s, "menu tail not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("menu entry added")