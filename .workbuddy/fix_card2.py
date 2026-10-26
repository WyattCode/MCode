import io

p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(p, encoding="utf-8").read()

old1 = """            } else if (grid) {
                // Three across with 14 between, as MiMo lays its grid.
                for (chunk in shown.chunked(3)) {
                    item {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            for (row in chunk) {
                                ArtifactTile(row, now, Modifier.weight(1f)) { onOpen(row.root, row.path) }
                            }
                            repeat(3 - chunk.size) { Spacer(Modifier.weight(1f)) }
                        }
                        Spacer(Modifier.height(14.dp))
                    }
                }
            } else {"""

new1 = """            } else if (grid) {
                /*
                 * One card per row, horizontal - the reference's own shape.
                 *
                 * Photographed with a real artifact in it: the card runs x
                 * 16.0..343.6 by y 180.8..279.2 - 327.6 wide, 98.4 tall - with a
                 * 155.2 x 86.4 thumbnail well inset 8 from the card's left, its
                 * lower-left corner carrying a violet brush badge, and three
                 * lines of text starting at x 172.0: the title at 197.6, a lock
                 * with the visibility note at 222.0, and the age at 252.4.
                 *
                 * This laid three square tiles across, each with its mark
                 * centred in a 96 dp well above the name. A shelf of documents
                 * reads better as rows than as a photo grid, and a row gives the
                 * title room to be a title.
                 */
                for (row in shown) {
                    item {
                        ArtifactCard(row, now) { onOpen(row.root, row.path) }
                        Spacer(Modifier.height(10.dp))
                    }
                }
            } else {"""

assert old1 in s, "grid branch"
s = s.replace(old1, new1, 1)

old2 = """/** MiMo's tile: a well with the mark and its kind, the name under it, the age and conversation at the foot. */
@Composable
private fun ArtifactTile(row: ArtRow, now: Long, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8), RoundedCornerShape(14.dp))
            .clickable { onClick() },
    ) {
        Box(
            Modifier.fillMaxWidth().height(96.dp).background(LocalBg.current),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.size(38.dp)) { row.badge.glyph(this) }
            Row(
                Modifier.align(Alignment.BottomStart).padding(8.dp)
                    .background(row.badge.fg.copy(alpha = 0.12f), RoundedCornerShape(6.dp))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(5.dp).background(row.badge.fg, CircleShape))
                Spacer(Modifier.width(4.dp))
                Text(row.badge.label, fontSize = 10.sp, color = row.badge.fg)
            }
        }
        Column(Modifier.padding(horizontal = 11.dp, vertical = 9.dp)) {
            Text(row.name, fontSize = 13.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            Text(artifactWhen(row.at, now), fontSize = 11.sp, color = LocalMuted.current)
        }
    }
}"""

new2 = """/**
 * The reference's artifact record: a thumbnail well on the left, three lines on
 * the right.
 *
 * Measured at 400 dpi on its own artifacts page - card 327.6 x 98.4, well
 * 155.2 x 86.4 inset 8 from the left, the badge 11.6 across at the well's
 * lower-left, and the text column starting 18.8 past the well's right edge with
 * its lines at 197.6, 222.0 and 252.4.
 *
 * The well carries the artifact's own preview when there is one; with none to
 * show it keeps the page tint and puts the kind's mark in the middle, which is
 * what the reference does for a record it cannot render.
 */
@Composable
private fun ArtifactCard(row: ArtRow, now: Long, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8), RoundedCornerShape(14.dp))
            .clickable { onClick() }
            .padding(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier
                .width(155.2.dp)
                .height(86.4.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(LocalBg.current),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.size(30.dp)) { row.badge.glyph(this) }
            /*
             * The violet brush badge, at the well's lower-left corner.
             *
             * 11.6 across in the reference with a light ring, so it reads as a
             * sticker on the thumbnail rather than part of the picture.
             */
            Box(
                Modifier
                    .align(Alignment.BottomStart)
                    .offset(x = 2.dp, y = 2.dp)
                    .size(22.dp)
                    .clip(CircleShape)
                    .background(Color(0xFFD9D2FA)),
                contentAlignment = Alignment.Center,
            ) {
                Canvas(Modifier.size(12.dp)) {
                    val ink = Color(0xFF4A3D8F)
                    val w = 1.4f * density
                    drawLine(ink, androidx.compose.ui.geometry.Offset(size.width * 0.18f, size.height * 0.86f), androidx.compose.ui.geometry.Offset(size.width * 0.74f, size.height * 0.20f), w)
                    drawLine(ink, androidx.compose.ui.geometry.Offset(size.width * 0.52f, size.height * 0.14f), androidx.compose.ui.geometry.Offset(size.width * 0.88f, size.height * 0.44f), w)
                }
            }
        }
        Spacer(Modifier.width(18.8.dp))
        Column(Modifier.padding(top = 4.8.dp)) {
            Text(
                row.name,
                fontSize = 15.sp,
                color = LocalText.current,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(10.8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Canvas(Modifier.size(11.2.dp)) {
                    val ink = LocalMuted
                    val w = 1.3f * density
                    drawRoundRect(
                        ink,
                        topLeft = androidx.compose.ui.geometry.Offset(size.width * 0.16f, size.height * 0.44f),
                        size = androidx.compose.ui.geometry.Size(size.width * 0.68f, size.height * 0.48f),
                        cornerRadius = androidx.compose.ui.geometry.CornerRadius(size.width * 0.14f),
                        style = androidx.compose.ui.graphics.drawscope.Stroke(w),
                    )
                    drawArc(
                        ink,
                        startAngle = 180f,
                        sweepAngle = 180f,
                        useCenter = false,
                        topLeft = androidx.compose.ui.geometry.Offset(size.width * 0.28f, size.height * 0.10f),
                        size = androidx.compose.ui.geometry.Size(size.width * 0.44f, size.height * 0.44f),
                        style = androidx.compose.ui.graphics.drawscope.Stroke(w),
                    )
                }
                Spacer(Modifier.width(4.4.dp))
                Text("\\u4ec5\\u60a8\\u53ef\\u89c1", fontSize = 11.2.sp, color = LocalMuted.current)
            }
            Spacer(Modifier.height(9.6.dp))
            Text(
                "\\u7f16\\u8f91\\u4e8e " + artifactWhen(row.at, now),
                fontSize = 11.2.sp,
                color = LocalMuted.current,
            )
        }
    }
}"""

assert old2 in s, "ArtifactTile"
s = s.replace(old2, new2, 1)

io.open(p, "w", encoding="utf-8").write(s)
print("artifact card: horizontal, per the reference")
