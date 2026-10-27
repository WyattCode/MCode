/**
 * An Office document, drawn by the WebView.
 *
 * The document was turned into one HTML page where the file is (see
 * `src/server/office/html.ts`), so this side has nothing to parse: a WebView
 * shows the page, which is the same arrangement the desktop has - a viewer that
 * renders, and a document turned into something renderable.
 *
 * The view is given the page as a string rather than a URL, and JavaScript is
 * off: the page is the converter's own output, it needs no script, and a reader
 * that never runs one cannot be made to by a document.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OfficeViewer(name: String, kind: String, html: String, onClose: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val dark = LocalBg.current == DarkBg
    ModalBottomSheet(onDismissRequest = onClose, containerColor = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    name,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    color = LocalText.current,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    kind.uppercase(),
                    fontSize = 11.sp,
                    color = LocalMuted.current,
                    modifier = Modifier
                        .background(LocalPill.current, RoundedCornerShape(6.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
                Spacer(Modifier.width(8.dp))
                Box(Modifier.size(34.dp).clickable { onClose() }, contentAlignment = Alignment.Center) {
                    Icon(Icons.Filled.Close, contentDescription = "关闭", tint = LocalMuted.current, modifier = Modifier.size(16.dp))
                }
            }
            Spacer(Modifier.height(8.dp))
            androidx.compose.ui.viewinterop.AndroidView(
                factory = { ctx ->
                    android.webkit.WebView(ctx).apply {
                        setBackgroundColor(if (dark) 0xFF151515.toInt() else 0xFFFFFEFD.toInt())
                        settings.javaScriptEnabled = false
                        settings.loadWithOverviewMode = true
                        settings.useWideViewPort = true
                        isVerticalScrollBarEnabled = false
                        // The page is handed over as a string with no base URL, so
                        // nothing it asks for can reach the network: its images are
                        // already data URLs.
                        loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(max = 640.dp),
            )
        }
    }
}

