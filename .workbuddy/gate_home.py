p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 主页判断：Recent 与 Sessions 都算"列表页"
HOME = "isListPage"

# 1) 顶栏占位
s = s.replace(
    "                    if (leftMode == LeftMode.Sessions) Box(Modifier.fillMaxWidth().height(63.2.dp)) {",
    "                    if (isListPage) Box(Modifier.fillMaxWidth().height(63.2.dp)) {", 1)

# 2) 左上角按钮：列表页开抽屉，否则返回列表
s = s.replace(
    "                                if (leftMode == LeftMode.Sessions) openDrawer() else leftMode = LeftMode.Sessions",
    "                                if (isListPage) openDrawer() else leftMode = LeftMode.Recent", 1)
s = s.replace(
    "                            if (leftMode == LeftMode.Sessions) {",
    "                            if (isListPage) {", 1)

# 3) 设备块 / 会话标题 / 搜索：只属于 Code 页
#    （设备块 3923、会话标题 4022 保持 Sessions-only）
s = s.replace(
    "                        if (leftMode == LeftMode.Sessions && !searching) {",
    "                        if (leftMode == LeftMode.Sessions && !searching) {", 1)
s = s.replace(
    "                        if (leftMode == LeftMode.Sessions && searching) Row(",
    "                        if (isListPage && searching) Row(", 1)

# 4) 底部胶囊
s = s.replace(
    "                        if (leftMode == LeftMode.Sessions) FootCapsule(",
    "                        if (isListPage) FootCapsule(", 1)

# 5) 定义 isListPage（插在左栏 Column 之前的位置：找 leftMode 声明后）
anchor = "    var leftMode by remember { mutableStateOf(LeftMode.Recent) }"
assert anchor in s
s = s.replace(anchor, anchor + """
    /*
     * Both list pages share the column's chrome - the drawer button, the header
     * bar, the search field, the foot capsule. Only the list's own skin and the
     * device block above it differ: 最近记录 is flat rows, Code is cards under a
     * 设备 panel.
     */
    val isListPage = leftMode == LeftMode.Recent || leftMode == LeftMode.Sessions""", 1)

open(p, "w", encoding="utf-8").write(s)
print("gated chrome on isListPage; device block stays Sessions-only")