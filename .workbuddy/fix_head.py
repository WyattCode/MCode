p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                                modifier = Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .clickable { searching = true }
                                    .padding(horizontal = 4.dp, vertical = 2.dp),
                            )
                            Spacer(Modifier.weight(1f))"""
new = """                                /*
                                 * No 4 dp inset of its own.
                                 *
                                 * The row already starts at 28.8, which is where
                                 * the reference's 会话 sits; the touch target's
                                 * own 4 pushed the word to 32.8 and made the
                                 * heading the only element in the block out of
                                 * line with 设备 above it and the cards below.
                                 */
                                modifier = Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .clickable { searching = true }
                                    .padding(vertical = 2.dp),
                            )
                            Spacer(Modifier.weight(1f))"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("会话 heading: removed 4dp inner inset")