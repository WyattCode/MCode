import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# State for the branch list.
old = '''    var changeBranch by remember { mutableStateOf("") }'''
new = '''    var changeBranch by remember { mutableStateOf("") }
    /** Branches offered under the change list; the desktop's branch chip does the same from the home screen. */
    val branches = remember { mutableStateListOf<String>() }
    var showBranches by remember { mutableStateOf(false) }'''
assert old in s
s = s.replace(old, new, 1)

# Load them with the status.
old2 = '''            changeBranch = data.optString("branch")'''
new2 = '''            changeBranch = data.optString("branch")
            branches.clear()
            runCatching { rpc(JSONObject().put("type", "git.branches").put("directory", root)) }
                .getOrNull()
                ?.optJSONObject("data")
                ?.optJSONArray("branches")
                ?.let { arr ->
                    for (i in 0 until arr.length()) {
                        val b = arr.optString(i)
                        if (b.isNotBlank()) branches.add(b)
                    }
                }'''
assert old2 in s
s = s.replace(old2, new2, 1)

# The branch says it is a control.
old3 = '''                    if (changeBranch.isNotBlank()) {
                        Text(changeBranch, fontSize = 12.sp, color = LocalMuted.current)
                    }'''
new3 = '''                    if (changeBranch.isNotBlank()) {
                        Row(
                            Modifier.clickable { showBranches = !showBranches },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(changeBranch, fontSize = 12.sp, color = LocalMuted.current)
                            Icon(
                                Icons.Outlined.ExpandMore,
                                contentDescription = "\\u5207\\u6362\\u5206\\u652f",
                                tint = LocalMuted.current,
                                modifier = Modifier.size(14.dp),
                            )
                        }
                    }'''
assert old3 in s
s = s.replace(old3, new3, 1)

# And the list of branches opens under the header.
old4 = '''                Spacer(Modifier.height(10.dp))
                if (changedFiles.isEmpty()) {'''
new4 = '''                if (showBranches && branches.isNotEmpty()) {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .padding(top = 8.dp)
                            .background(LocalPill.current, RoundedCornerShape(10.dp))
                            .padding(vertical = 4.dp),
                    ) {
                        for (b in branches) {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        showBranches = false
                                        scope.launch {
                                            runCatching {
                                                rpc(
                                                    JSONObject()
                                                        .put("type", "git.checkout")
                                                        .put("directory", root)
                                                        .put("branch", b),
                                                )
                                            }
                                            changeBranch = b
                                        }
                                    }
                                    .padding(horizontal = 12.dp, vertical = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    b,
                                    fontSize = 13.sp,
                                    color = if (b == changeBranch) LocalText.current else LocalMuted.current,
                                    modifier = Modifier.weight(1f),
                                )
                                if (b == changeBranch) {
                                    Icon(Icons.Filled.Check, contentDescription = null, tint = LocalText.current, modifier = Modifier.size(14.dp))
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                if (changedFiles.isEmpty()) {'''
assert old4 in s
s = s.replace(old4, new4, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("branch switcher added")