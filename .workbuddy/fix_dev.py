p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1. 设备 label: start 14.8 -> 28.8, and give it the reference's 41.6 above it
old_label = """                                "设备",
                                fontSize = 12.sp,
                                color = LocalMuted.current,
                                modifier = Modifier.padding(start = 14.8.dp, top = 10.dp, bottom = 6.dp),"""
new_label = """                                "设备",
                                fontSize = 12.sp,
                                color = LocalMuted.current,
                                /*
                                 * 28.8 in, 41.6 under the header's ink.
                                 *
                                 * Measured on the reference: 设备 starts at x
                                 * 28.8 and its top is 41.6 below the header
                                 * block's bottom; the capsule under it is 36.8
                                 * below the label's own bottom. This sat at 14.8
                                 * with 10/6, which pulled the label left against
                                 * the column edge and stacked everything under it
                                 * 14 dp too high - the whole block drifted up.
                                 */
                                modifier = Modifier.padding(start = 28.8.dp, top = 38.4.dp, bottom = 22.8.dp),"""
assert old_label in s, "device label not found"
s = s.replace(old_label, new_label, 1)

open(p, "w", encoding="utf-8").write(s)
print("device label: start 28.8, gaps 38.4 / 22.8")