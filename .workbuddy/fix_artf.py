p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) 删掉「产物中心」大标题和两行说明——参考件没有
old1 = """            item {
                Text("产物中心", fontSize = 24.sp, lineHeight = 30.sp, color = LocalText.current)
                Spacer(Modifier.height(6.dp))
                Text(
                    "这里汇总了你在 MCode 里生成过的全部产物，可预览、下载或回到对话继续",
                    fontSize = 13.sp,
                    lineHeight = 20.sp,
                    color = LocalMuted.current,
                )
                Spacer(Modifier.height(16.dp))
                /*"""
new1 = """            item {
                /*
                 * No page heading and no blurb.
                 *
                 * Photographed on the reference's artifacts page with a real
                 * artifact in it: the bar says Artifacts, and the page goes
                 * straight to the search field at y 104.8 - no 「产物中心」, no
                 * sentence under it. This opened with a 24sp heading and two
                 * lines of explanation, which pushed the field from 104.8 to
                 * 210.4 and made the page read as a marketing screen rather than
                 * a shelf.
                 */
                /*"""
assert old1 in s, "heading"
s = s.replace(old1, new1, 1)

# 2) 左右 padding 40 -> 16，顶部 14 -> 8.4（参考搜索框 y104.8，顶栏 72.0 结束）
old2 = """            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 40.dp, end = 40.dp, top = 14.dp, bottom = 40.dp),"""
new2 = """            /*
             * 16 either side, as the reference: its field and card both run
             * x 16.0..343.6. This used 40, which is where the 40.0 x-start of
             * every row came from.
             */
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 16.dp, end = 16.dp, top = 8.4.dp, bottom = 40.dp),"""
assert old2 in s, "padding"
s = s.replace(old2, new2, 1)

open(p, "w", encoding="utf-8").write(s)
print("artifacts: heading removed, padding 16")
