p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = ".background(if (androidx.compose.foundation.isSystemInDarkTheme()) LocalCard.current else Color.White)"
new = """/*
                                     * No fill at all.
                                     *
                                     * Sampled inside the reference's pill at
                                     * three points: (249,249,247) - the page's
                                     * own colour. The capsule is an outline on
                                     * the page, not a white plate on it. The
                                     * thumbnail made it look filled; the pixels
                                     * say otherwise, which is why this is
                                     * measured rather than eyeballed.
                                     */"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("capsule: fill removed (outline only)")