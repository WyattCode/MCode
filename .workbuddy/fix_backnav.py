import re

p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# onClose 是"这一页的返回/关闭"，应该回主页 Recent，不是 Code。
# onNew（新建后）也回主页。
# onSessions 是抽屉里的 Code 项，必须保持 Sessions。
before = s.count("onClose = { leftMode = LeftMode.Sessions }")
s = s.replace("onClose = { leftMode = LeftMode.Sessions }", "onClose = { leftMode = LeftMode.Recent }")

# 新建之后回到主页列表，而不是 Code 的设备面板
s = s.replace("onNew = { newSession(); leftMode = LeftMode.Sessions }", "onNew = { newSession(); leftMode = LeftMode.Recent }")

# 3086 / 3111 是 BackHandler 里的裸赋值，同样是"退出这一页"
s = s.replace("""                    leftMode = LeftMode.Sessions""", """                    leftMode = LeftMode.Recent""")
s = s.replace("""                leftMode = LeftMode.Sessions""", """                leftMode = LeftMode.Recent""")

open(p, "w", encoding="utf-8").write(s)
print("onClose/onNew -> Recent: %d sites; onSessions kept" % before)
print("remaining Sessions refs:")
for i, line in enumerate(open(p, encoding="utf-8"), 1):
    if "leftMode = LeftMode.Sessions" in line:
        print("  %d: %s" % (i, line.strip()))