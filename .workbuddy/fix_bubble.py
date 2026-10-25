p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """"M4.6 5.4h14.8a1.6 1.6 0 0 1 1.6 1.6v8.2a1.6 1.6 0 0 1-1.6 1.6H10.4L6.2 20v-3.2H4.6A1.6 1.6 0 0 1 3 15.2V7a1.6 1.6 0 0 1 1.6-1.6Z","""
new = """/*
                                 * Round, not a rounded rectangle.
                                 *
                                 * Enlarged from the drawer, the reference's mark
                                 * is a circle with a short tail at its lower
                                 * left - the tail is a straight notch, not a
                                 * second lobe. The 1.6-cornered rectangle this
                                 * drew read as a chat panel next to the
                                 * reference's round one.
                                 */
                                "M12 3.4a8.6 8.6 0 1 0-4.6 15.9L6 21.4l4.6-2.4a8.6 8.6 0 0 0 1.4 0A8.6 8.6 0 0 0 12 3.4Z","""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("bubble: circle with a lower-left tail")