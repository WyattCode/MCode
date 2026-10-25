p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 箭头：Box(44dp) 在 x 379.6，需要移到 400.8 -> 加 21.2 左偏移
old = """                            Box(Modifier.size(44.dp).clickable { openDrawer() }, contentAlignment = Alignment.Center) {
                                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回", tint = LocalText.current, modifier = Modifier.size(20.dp))
                            }"""
new = """                            /*
                             * The back arrow starts 40.8 in, not 19.6.
                             *
                             * Measured on the reference's own conversation header:
                             * its arrow's ink runs x 400.8..414.8, which inside a
                             * 360 dp-wide pane is 40.8 from the seam. This drew at
                             * 379.6..392.4 - 21.2 left, tucked against the divider
                             * instead of standing off it.
                             */
                            Box(Modifier.size(44.dp).offset(x = 21.2.dp).clickable { openDrawer() }, contentAlignment = Alignment.Center) {
                                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回", tint = LocalText.current, modifier = Modifier.size(20.dp))
                            }"""
assert old in s, "back arrow"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("back arrow: +21.2")
