p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                            Row(
                                Modifier
                                    /* Reference: the capsule starts at x 30.0. */
                                    .padding(start = 30.dp)
                                    .height(31.6.dp)
                                    .clip(RoundedCornerShape(15.8.dp))
                                    .border(1.dp, LocalCardLine.current, RoundedCornerShape(15.8.dp))
                                    .background(LocalCard.current)
                                    .clickable { showConnect = true }
                                    .padding(horizontal = 14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {"""

new = """                            Row(
                                Modifier
                                    /*
                                     * Height first, then the plate, then the inset.
                                     *
                                     * `padding(start = 30.dp)` was the first
                                     * modifier here, so everything after it -
                                     * height, clip, border, background - sized
                                     * and painted the area left over *inside*
                                     * that 30 dp inset. The capsule's plate and
                                     * its hairline were being drawn in a box
                                     * whose left edge had already been pushed
                                     * 30 in, and the row drew as bare text.
                                     * The inset belongs at the end, where it
                                     * moves the whole pill rather than resizing
                                     * what sits behind it.
                                     */
                                    .padding(start = 30.dp)
                                    .height(31.6.dp)
                                    .clip(RoundedCornerShape(15.8.dp))
                                    .background(LocalCard.current)
                                    .border(1.dp, LocalCardLine.current, RoundedCornerShape(15.8.dp))
                                    .clickable { showConnect = true }
                                    .padding(horizontal = 14.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("capsule: background before border (border was being clipped away)")