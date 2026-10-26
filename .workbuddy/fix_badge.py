p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """            /*
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
            }"""

new = """            /*
             * The palette sticker, at the well's lower-left corner.
             *
             * A 23.6 square flush with the well's own left edge and standing on
             * its bottom edge - x 28.0..51.6, y 243.6..267.2 against a well that
             * runs to 267.6. Not a circle overhanging the corner, which is what
             * I drew first off the thumbnail.
             *
             * Enlarged 6x, the mark inside is a palette: a rounded body with a
             * notch bitten out at its lower right and four dots on its face, in
             * #5C50AC on a #DEDBFA ground. It marks the record as something the
             * model drew rather than something the reader wrote.
             */
            Box(
                Modifier
                    .align(Alignment.BottomStart)
                    .size(23.6.dp)
                    .background(Color(0xFFDEDBFA), RoundedCornerShape(4.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Canvas(Modifier.size(15.2.dp)) {
                    val ink = Color(0xFF5C50AC)
                    val w = 1.5f * density
                    val path = androidx.compose.ui.graphics.Path().apply {
                        moveTo(size.width * 0.10f, size.height * 0.52f)
                        cubicTo(
                            size.width * 0.10f, size.height * 0.18f,
                            size.width * 0.90f, size.height * 0.18f,
                            size.width * 0.90f, size.height * 0.52f,
                        )
                        cubicTo(
                            size.width * 0.90f, size.height * 0.74f,
                            size.width * 0.72f, size.height * 0.80f,
                            size.width * 0.60f, size.height * 0.72f,
                        )
                        lineTo(size.width * 0.52f, size.height * 0.90f)
                        cubicTo(
                            size.width * 0.34f, size.height * 0.96f,
                            size.width * 0.10f, size.height * 0.82f,
                            size.width * 0.10f, size.height * 0.52f,
                        )
                        close()
                    }
                    drawPath(path, ink, style = androidx.compose.ui.graphics.drawscope.Stroke(w))
                    for (fx in listOf(0.32f, 0.52f, 0.72f)) {
                        drawCircle(ink, radius = 1.3f * density, center = androidx.compose.ui.geometry.Offset(size.width * fx, size.height * 0.40f))
                    }
                    drawCircle(ink, radius = 1.3f * density, center = androidx.compose.ui.geometry.Offset(size.width * 0.28f, size.height * 0.64f))
                }
            }"""

assert old in s, "badge"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("badge: palette sticker 23.6 square")
