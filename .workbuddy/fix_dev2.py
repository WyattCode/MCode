p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# capsule left inset: 14.8 -> 30.0 (reference: x 30.0..116.8)
old = """                            Row(
                                Modifier
                                    .padding(start = 14.8.dp)
                                    .height(31.6.dp)"""
new = """                            Row(
                                Modifier
                                    /* Reference: the capsule starts at x 30.0. */
                                    .padding(start = 30.dp)
                                    .height(31.6.dp)"""
assert old in s, "capsule inset not found"
s = s.replace(old, new, 1)

# 会话 / 全部 heading row: reference top gap is 44.0 below the capsule
old2 = """                        if (leftMode == LeftMode.Sessions && !searching) Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(start = 28.8.dp, end = 20.4.dp, top = 12.dp, bottom = 4.dp),"""
new2 = """                        if (leftMode == LeftMode.Sessions && !searching) Row(
                            Modifier
                                .fillMaxWidth()
                                /*
                                 * 44.0 above, measured: the capsule's bottom is
                                 * at 178.0 and 会话's ink starts at 222.4.
                                 */
                                .padding(start = 28.8.dp, end = 20.4.dp, top = 40.dp, bottom = 8.dp),"""
assert old2 in s, "sessions heading not found"
s = s.replace(old2, new2, 1)

open(p, "w", encoding="utf-8").write(s)
print("capsule start 30, sessions heading top 40")