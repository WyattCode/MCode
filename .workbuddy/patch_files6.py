import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# Replace the in-sheet preview with a separate dialog, which is a clean layer of
# its own and cannot be clipped by the sheet's measured height.
old_preview_start = '''                val shown = filePreview'''
idx = s.index(old_preview_start)
end_marker = '''    /* ---- \u529f\u80fd\u9762\u677f'''
end = s.index(end_marker, idx)
# Everything from `val shown` to the closing of the sheet's Column.
s = s[:idx] + s[end:]

# Add the preview dialog just before the panel section.
dialog = '''    /*
     * A file opens in its own sheet rather than at the bottom of the folder
     * list: a bottom sheet measures its height when it opens, so the preview
     * added later was clipped away. This is also how the desktop shows one -
     * a reading surface of its own.
     */
    filePreview?.let { (name, body) ->
        ModalBottomSheet(onDismissRequest = { filePreview = null }, containerColor = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 25.dp)) {
                Text(name, fontSize = 15.sp, fontWeight = FontWeight.Medium, color = LocalText.current, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(10.dp))
                LazyColumn(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = 520.dp)
                        .background(LocalPill.current, RoundedCornerShape(10.dp))
                        .padding(10.dp),
                ) {
                    val lines = body.lineSequence().take(300).toList()
                    items(lines.size) { i ->
                        Text(
                            lines[i].ifEmpty { " " },
                            fontSize = 11.sp,
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            color = LocalText.current,
                            softWrap = true,
                        )
                    }
                }
            }
        }
    }

'''
s = s.replace(end_marker, dialog + end_marker, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("preview moved to its own sheet")