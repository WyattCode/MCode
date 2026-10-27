import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# Panel + loader, placed beside the other sheets (before the usage sheet block).
old = '''    /* ---- \u529f\u80fd\u9762\u677f\uff1a\u4efb\u52a1 / \u9879\u76ee / \u5b9a\u65f6\u4efb\u52a1 / \u4f1a\u8bdd\u957f\u6309 / \u91cd\u547d\u540d ---- */'''

new = '''    /*
     * The project browser: the folder walked one level at a time, text files
     * shown as they are. The desktop has this as a permanent rail; on a tablet
     * it belongs in a sheet, opened from the header, and it is the shortest way
     * to answer "what is actually in this repository" from a phone.
     */
    if (showFiles) {
        val root = sessions.find { it.id == currentSession }?.directory.orEmpty()
        val sub = fileStack.last()
        LaunchedEffect(root, sub) {
            fileEntries.clear()
            filePreview = null
            val ticket = "fs${System.nanoTime()}"
            val deferred = client.awaitResponse(ticket)
            request(JSONObject().put("type", "file.listDir").put("directory", root).put("sub", sub), ticket)
            val res = runCatching { deferred.await() }.getOrNull() ?: return@LaunchedEffect
            val arr = res.optJSONObject("data")?.optJSONArray("entries") ?: return@LaunchedEffect
            val list = mutableListOf<Pair<String, Boolean>>()
            for (i in 0 until arr.length()) {
                val e = arr.optJSONObject(i) ?: continue
                list.add(e.optString("name") to (e.optString("type") == "dir"))
            }
            fileEntries.addAll(list.sortedWith(compareByDescending<Pair<String, Boolean>> { it.second }.thenBy { it.first }))
        }
        ModalBottomSheet(onDismissRequest = { showFiles = false }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (fileStack.size > 1) {
                        Box(Modifier.size(36.dp).clickable { fileStack = fileStack.dropLast(1) }, contentAlignment = Alignment.Center) {
                            Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "\u4e0a\u4e00\u7ea7", tint = LocalText.current, modifier = Modifier.size(18.dp))
                        }
                    }
                    Text(
                        "/" + sub,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Medium,
                        color = LocalText.current,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).padding(start = if (fileStack.size > 1) 4.dp else 0.dp),
                    )
                }
                Spacer(Modifier.height(8.dp))
                LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 460.dp)) {
                    items(fileEntries.size) { index ->
                        val (name, isDir) = fileEntries[index]
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    if (isDir) {
                                        fileStack = fileStack + if (sub.isBlank()) name else "$sub/$name"
                                    } else {
                                        val rel = if (sub.isBlank()) name else "$sub/$name"
                                        val ticket = "fr${System.nanoTime()}"
                                        scope.launch {
                                            val deferred = client.awaitResponse(ticket)
                                            request(JSONObject().put("type", "file.read").put("root", root).put("rel", rel), ticket)
                                            val r = runCatching { deferred.await() }.getOrNull() ?: return@launch
                                            val body = r.optJSONObject("data")?.optString("text").orEmpty()
                                            filePreview = rel to body
                                        }
                                    }
                                }
                                .padding(vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                if (isDir) Icons.Outlined.Folder else Icons.AutoMirrored.Outlined.Article,
                                contentDescription = null,
                                tint = LocalMuted.current,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(Modifier.width(10.dp))
                            Text(name, fontSize = 14.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                filePreview?.let { (name, body) ->
                    Spacer(Modifier.height(10.dp))
                    Text(name, fontSize = 12.sp, color = LocalMuted.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(6.dp))
                    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 220.dp).background(LocalPill.current, RoundedCornerShape(10.dp)).padding(8.dp)) {
                        val lines = body.lineSequence().take(80).toList()
                        items(lines.size) { i ->
                            Text(lines[i].ifEmpty { " " }, fontSize = 11.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, color = LocalText.current, maxLines = 1)
                        }
                    }
                }
            }
        }
    }

    /* ---- \u529f\u80fd\u9762\u677f\uff1a\u4efb\u52a1 / \u9879\u76ee / \u5b9a\u65f6\u4efb\u52a1 / \u4f1a\u8bdd\u957f\u6309 / \u91cd\u547d\u540d ---- */'''

assert old in s, "panel section marker not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("file panel added")