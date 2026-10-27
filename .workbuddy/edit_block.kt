/** One file a turn wrote, and how it changed. */
data class EditedFile(val path: String, val add: Int, val del: Int, val created: Boolean)

/**
 * The files a tool call wrote, with the line counts its patch carries.
 *
 * The desktop's card reads these from its live diff (`EditedFilesCard.vue`); a
 * phone has no live diff, so they are counted out of the call's own output -
 * the same `+`/`-` lines `DiffLines` colours - which is what the numbers mean
 * anyway. A `write` that had no patch to show is a file that did not exist
 * before, so it counts as created.
 */
fun editedOf(part: JSONObject): EditedFile? {
    val name = part.optString("name")
    if (name != "edit" && name != "write" && name != "patch" && name != "apply_patch") return null
    val state = part.optJSONObject("state")
    val status = state?.optString("status").orEmpty().ifBlank { part.optString("status") }
    if (status.isNotEmpty() && status != "completed") return null
    val input = part.optJSONObject("input")
    val path = input?.optString("path").orEmpty()
        .ifBlank { input?.optString("filePath").orEmpty() }
        .ifBlank { input?.optString("file_path").orEmpty() }
        .ifBlank { part.optString("title") }
    if (path.isBlank()) return null
    val patch = state?.optString("output").orEmpty().ifBlank { part.optString("output") }
    var add = 0
    var del = 0
    for (line in patch.lineSequence()) {
        if (line.startsWith("+") && !line.startsWith("+++")) add += 1
        else if (line.startsWith("-") && !line.startsWith("---")) del += 1
    }
    val created = name == "write" && patch.isBlank()
    return EditedFile(path, add, del, created)
}

/**
 * The turn's edits as one card, the way the desktop draws them.
 *
 * `EditedFilesCard.vue`: a 19 mark - a sheet with a plus over a minus when
 * several files changed, a plus when one was created, a pencil otherwise - the
 * name, and the change in the two state colours. One file names itself; several
 * say how many. Tapping a single file opens it.
 */
@Composable
fun EditedCard(files: List<EditedFile>, root: String, onOpen: ((String, String) -> Unit)?) {
    if (files.isEmpty()) return
    val add = files.sumOf { it.add }
    val del = files.sumOf { it.del }
    val single = files.singleOrNull()
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 6.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(
                1.dp,
                if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8),
                RoundedCornerShape(12.dp),
            )
            .then(if (single != null && onOpen != null) Modifier.clickable { onOpen(root, single.path) } else Modifier)
            .padding(horizontal = 14.dp, vertical = 11.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            MiIcon(
                when {
                    files.size > 1 -> "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM12 7.5v5M9.5 10h5M9.5 16h5"
                    single!!.created -> "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5M12 11v6M9 14h6"
                    else -> "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4M14 3v5h5v2M19.4 13.6a1.9 1.9 0 0 1 0 2.7L15 20.7l-3 .8.8-3 4.4-4.4a1.9 1.9 0 0 1 2.2-.5Z"
                },
                modifier = Modifier.size(19.dp),
                strokeWidth = 1.7f,
                tint = LocalText.current,
            )
            Spacer(Modifier.width(10.dp))
            Text(
                if (single != null) "编辑 ${single.path.substringAfterLast('/').substringAfterLast('\\\\')}" else "编辑了 ${files.size} 个文件",
                fontSize = 14.sp,
                color = LocalText.current,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (add > 0 || del > 0) {
                // The two state colours, as the desktop writes them.
                Text("+$add", fontSize = 12.sp, color = diffAddInk())
                Spacer(Modifier.width(6.dp))
                Text("-$del", fontSize = 12.sp, color = diffDelInk())
            }
        }
        // More than one file: the list, so the reader knows which.
        if (files.size > 1) {
            Spacer(Modifier.height(6.dp))
            for (file in files.take(5)) {
                Text(
                    "· " + file.path.substringAfterLast('/').substringAfterLast('\\\\'),
                    fontSize = 12.sp,
                    color = LocalMuted.current,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (files.size > 5) {
                Text("…还有 ${files.size - 5} 个", fontSize = 12.sp, color = LocalMuted.current)
            }
        }
    }
}

