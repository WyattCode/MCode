p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                /*
                 * Seven, counted off the drawer itself.
                 *
                 * Photographed at 400 dpi: 最近使用 lists Main, 大模型推理部署方案,
                 * 笼管交换机级联, 电影剧情总结, Python code request, Run and
                 * macOS 屏幕保护密码设置 - seven rows, first title at y 390.0 and
                 * the last at 711.2, a 28-to-31 dp pitch - with 查看全部 under
                 * them at 832.8.
                 *
                 * The comment here said six while the code said three; both were
                 * guesses at a number that is plainly visible once the drawer is
                 * photographed rather than recalled.
                 */
                sessions.take(7),"""

new = """                /*
                 * Six, and at a 43.4 pitch.
                 *
                 * Counted off the drawer photographed this pass: Main, 大模型推理
                 * 部署方案, 笼管交换机级联, 电影剧情总结, Python code request,
                 * macOS 屏幕保护密码设置 - six titles at y 390.0, 432.4, 476.0,
                 * 519.6, 564.4, 606.8, with 查看全部 at 654.4.
                 *
                 * The note here previously claimed seven rows at a 28-to-31
                 * pitch, which was a reading of a *different* screenshot whose
                 * rows I had counted through a window that cut off the fifth.
                 * Six at 43.4 is what the drawer itself shows, and 43.6 is
                 * already the compact row height, so only the count was wrong.
                 */
                sessions.take(6),"""
assert old in s, "take(7) block"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("drawer list: take(7) -> take(6)")