import re

p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) 枚举加 Recent（code 页仍是 Sessions）
old_enum = "enum class LeftMode { Sessions, Projects, Artifacts, Scheduled, Plugins, Settings }"
new_enum = """enum class LeftMode { Recent, Sessions, Projects, Artifacts, Scheduled, Plugins, Settings }"""
assert old_enum in s
s = s.replace(old_enum, new_enum, 1)

# 2) 默认落在 Recent（Claude 启动就是最近记录）
old_def = "    var leftMode by remember { mutableStateOf(LeftMode.Sessions) }"
new_def = """    /*
     * Recent, not Sessions.
     *
     * Opened fresh, Claude lands on 最近记录 - a flat list of conversations -
     * and Code is a separate destination reached from the drawer. This used to
     * start on Sessions, which is the Code page, so the first thing the app
     * showed was a column headed 设备 with cards under it.
     */
    var leftMode by remember { mutableStateOf(LeftMode.Recent) }"""
assert old_def in s
s = s.replace(old_def, new_def, 1)

open(p, "w", encoding="utf-8").write(s)
print("enum: added Recent; default -> Recent")