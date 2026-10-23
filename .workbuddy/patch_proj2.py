import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                if (projects.isEmpty()) {
                    Column('''

new = '''                /*
                 * Claude parks a black 「+ 新建项目」 capsule at the foot of its
                 * project page. Here it opens a field for a folder path, which
                 * is what `project.add` takes - the desktop's picker is a native
                 * dialog and has no phone equivalent.
                 */
                var adding by remember { mutableStateOf(false) }
                var newPath by remember { mutableStateOf("") }
                if (adding) {
                    Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            newPath,
                            { newPath = it },
                            Modifier.weight(1f),
                            placeholder = { Text("D:\\\\Projects\\\\my-app", fontSize = 13.sp, color = LocalMuted.current) },
                            singleLine = true,
                            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp),
                            shape = RoundedCornerShape(10.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        TextButton(
                            {
                                val dir = newPath.trim()
                                if (dir.isNotBlank()) {
                                    scope.launch {
                                        runCatching {
                                            rpc(JSONObject().put("type", "project.add").put("directory", dir).put("used", false))
                                        }
                                        adding = false
                                        newPath = ""
                                        showProjects = false
                                    }
                                }
                            },
                        ) { Text("添加") }
                    }
                } else {
                    Surface(
                        shape = RoundedCornerShape(24.dp),
                        color = LocalText.current,
                        modifier = Modifier
                            .padding(top = 14.dp)
                            .align(Alignment.CenterHorizontally)
                            .clickable { adding = true },
                    ) {
                        Row(Modifier.padding(horizontal = 18.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("+", fontSize = 16.sp, color = LocalBg.current)
                            Spacer(Modifier.width(6.dp))
                            Text("新建项目", fontSize = 14.sp, color = LocalBg.current)
                        }
                    }
                }
                if (projects.isEmpty()) {
                    Column('''

assert old in s, "empty state anchor not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("new project control added")