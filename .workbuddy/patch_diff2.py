import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

anchor = '''    /*
     * A file opens in its own sheet rather than at the bottom of the folder'''

panel = '''    /*
     * The changes rail. A turn that edited files is the thing most worth
     * checking from a phone, and until now the only way was to ask the model
     * what it had done.
     */
    if (showChanges) {
        val root = sessions.find { it.id == currentSession }?.directory.orEmpty()
        LaunchedEffect(root) {
            changedFiles.clear()
            val r = runCatching { rpc(JSONObject().put("type", "git.status").put("directory", root)) }.getOrNull()
            val data = r?.optJSONObject("data") ?: return@LaunchedEffect
            changeBranch = data.optString("branch")
            data.optJSONArray("changed")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val f = arr.optString(i)
                    if (f.isNotBlank()) changedFiles.add(f)
                }
            }
        }
        ModalBottomSheet(onDismissRequest = { showChanges = false }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("\u672c\u6b21\u6539\u52a8", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = LocalText.current)
                    Spacer(Modifier.width(8.dp))
                    if (changeBranch.isNotBlank()) {
                        Text(changeBranch, fontSize = 12.sp, color = LocalMuted.current)
                    }
                }
                Spacer(Modifier.height(10.dp))
                if (changedFiles.isEmpty()) {
                    Text("\u6ca1\u6709\u672a\u63d0\u4ea4\u7684\u6539\u52a8", fontSize = 13.sp, color = LocalMuted.current)
                } else {
                    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 460.dp)) {
                        items(changedFiles.size) { i ->
                            val file = changedFiles[i]
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        scope.launch {
                                            val r = runCatching {
                                                rpc(JSONObject().put("type", "git.diff").put("directory", root).put("file", file))
                                            }.getOrNull() ?: return@launch
                                            changePatch = file to (r.optJSONObject("data")?.optString("patch").orEmpty())
                                        }
                                    }
                                    .padding(vertical = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    file,
                                    fontSize = 13.sp,
                                    color = LocalText.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = LocalMuted.current, modifier = Modifier.size(14.dp))
                            }
                        }
                    }
                }
            }
        }
    }

    /*
     * The patch itself, in its own sheet for the same reason the file preview
     * is: a bottom sheet measures once, and content added later is clipped.
     * Added lines are green and removed red, as the desktop colours them.
     */
    changePatch?.let { (file, patch) ->
        ModalBottomSheet(onDismissRequest = { changePatch = null }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 25.dp)) {
                Text(file, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = LocalText.current, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(10.dp))
                LazyColumn(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = 520.dp)
                        .background(LocalPill.current, RoundedCornerShape(10.dp))
                        .padding(10.dp),
                ) {
                    val lines = patch.lineSequence().take(400).toList()
                    items(lines.size) { i ->
                        val line = lines[i]
                        val tint = when {
                            line.startsWith("+") && !line.startsWith("+++") -> Color(0xFF2E7D32)
                            line.startsWith("-") && !line.startsWith("---") -> Color(0xFFC62828)
                            else -> LocalText.current
                        }
                        Text(
                            line.ifEmpty { " " },
                            fontSize = 10.5.sp,
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            color = tint,
                            softWrap = true,
                        )
                    }
                }
            }
        }
    }

'''

assert anchor in s, "anchor not found"
s = s.replace(anchor, panel + anchor, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("changes panel added")