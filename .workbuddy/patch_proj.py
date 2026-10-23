import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                if (projects.isEmpty()) Text("会话还没有目录信息", fontSize = 13.sp, color = LocalMuted.current)'''

new = '''                /*
                 * Claude's empty state is a large outlined folder with two
                 * lines under it - 「暂无项目」 then a sentence saying what will
                 * appear there. This printed one small grey line, which reads
                 * as an error rather than as a page waiting to be filled.
                 */
                if (projects.isEmpty()) {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 40.dp, bottom = 28.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            Icons.Outlined.FolderOpen,
                            contentDescription = null,
                            tint = LocalMuted.current.copy(alpha = 0.55f),
                            modifier = Modifier.size(63.dp),
                        )
                        Spacer(Modifier.height(18.dp))
                        Text("暂无项目", fontSize = 15.sp, color = LocalText.current)
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "您创建或加入的项目将显示在此处。",
                            fontSize = 13.sp,
                            color = LocalMuted.current,
                        )
                    }
                }'''

assert old in s, "empty state line not found"
s = s.replace(old, new, 1)

if "import androidx.compose.material.icons.outlined.FolderOpen" not in s:
    s = s.replace(
        "import androidx.compose.material.icons.outlined.Folder\n",
        "import androidx.compose.material.icons.outlined.Folder\nimport androidx.compose.material.icons.outlined.FolderOpen\n",
        1,
    )
io.open(path, "w", encoding="utf-8").write(s)
print("project empty state added")