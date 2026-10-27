p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                /*
                 * Six, not three.
                 *
                 * Counted off the reference's own drawer at 400dpi: its 最近使用
                 * block lists Main, 笼管交换机级联, 大模型推理部署方案,
                 * Python code request, Run and macOS 屏幕保护密码设置 - six rows
                 * at 385.2 / 428.8 / 472.4 / 516.0 / 559.6 / 603.2, a 43.6
                 * pitch - with 查看全部 under them at 650.8. Three was this
                 * app's own guess and left the block half empty.
                 */
                sessions.take(3),"""

new = """                /*
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
assert old in s, "take(3) block not found"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("drawer recent list: take(3) -> take(7)")