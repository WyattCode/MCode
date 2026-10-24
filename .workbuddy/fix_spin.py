p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                                Canvas(Modifier.size(18.dp)) {
                                    withTransform({ rotate(angle) }) {
                                        drawArc(
                                            color = Color(0xFF9C9A93),
                                            startAngle = 0f,
                                            sweepAngle = 200f,
                                            useCenter = false,
                                            style = Stroke(width = 2.6f * density, cap = StrokeCap.Round),
                                        )
                                    }
                                }"""

new = """                                /*
                                 * 20 dp, and a heavy arc.
                                 *
                                 * Measured on the reference's own running card:
                                 * the ring's ink runs 20.0 dp wide by 14.0 tall -
                                 * it is an open arc, taller than a half circle
                                 * would be, and its stroke is thick relative to
                                 * its size. 18 dp at 2.6 read as a hairline hoop
                                 * beside a 36 dp tile.
                                 */
                                Canvas(Modifier.size(20.dp)) {
                                    withTransform({ rotate(angle) }) {
                                        drawArc(
                                            color = Color(0xFF9C9A93),
                                            startAngle = 0f,
                                            sweepAngle = 220f,
                                            useCenter = false,
                                            style = Stroke(width = 3.2f * density, cap = StrokeCap.Round),
                                        )
                                    }
                                }"""

assert old in s, "spinner not found"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("spinner 18 -> 20, stroke 2.6 -> 3.2")