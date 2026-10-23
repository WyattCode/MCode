import io

p = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(p, encoding="utf-8").read()

old = '''            Icon(
                when (item.name) {
                    "read" -> Icons.AutoMirrored.Outlined.Article
                    "edit", "write", "apply_patch", "patch" -> Icons.Outlined.Edit
                    "bash", "exec_command", "execute" -> Icons.Outlined.Terminal
                    "grep", "glob" -> Icons.Outlined.Search
                    "list" -> Icons.Outlined.Folder
                    "webfetch", "websearch" -> Icons.Outlined.Language
                    else -> Icons.Outlined.Build
                },
                contentDescription = null,
                tint = rowTint,
                modifier = Modifier.size(15.dp),
            )
            Spacer(Modifier.width(7.dp))
            Text(
                toolVerbOf(item.name, item.status) + if (item.title.isNotBlank()) " ${item.title}" else "",
                fontSize = 12.5.sp,
                color = if (failed || busy) rowTint else LocalMuted.current,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (item.output.isNotBlank()) {
                Icon(
                    if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                    contentDescription = if (open) "收起" else "展开",
                    tint = LocalMuted.current,
                    modifier = Modifier.size(16.dp),
                )
            }'''

new = '''            /*
             * No icon: Claude's own tool row is words and a chevron -
             * 「已使用 PowerShell ›」, 「正在读取 ›」 - at 53px of line height. A
             * glyph per call added a column of little pictures down the
             * transcript the original never had, and pushed the words away from
             * where they are read from.
             */
            Text(
                toolVerbOf(item.name, item.status) + if (item.title.isNotBlank()) " ${item.title}" else "",
                fontSize = 13.sp,
                color = if (failed || busy) rowTint else LocalMuted.current,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (item.output.isNotBlank()) {
                Icon(
                    Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                    contentDescription = if (open) "收起" else "展开",
                    tint = LocalMuted.current,
                    modifier = Modifier.size(14.dp).graphicsLayer { rotationZ = if (open) 90f else 0f },
                )
            }'''

assert old in s, "tool row block not found"
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8").write(s)
print("tool row is words now")