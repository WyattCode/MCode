p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

start = s.find("""            /*
             * 最近记录, the reference's first row.""")
assert start > 0
end = s.find("""            /*
             * 「Code」, opening the conversation list - the reference's own""", start)
assert end > start
removed = s[start:end]
print("removing %d chars" % len(removed))

new = """            /*
             * 最近记录 is not a drawer row.
             *
             * I added one last pass on the assumption that the home list must be
             * a destination like the others. Photographed, Claude's drawer has
             * exactly four rows - 项目, Code, Artifacts, 定时任务 - and 最近记录
             * appears in none of them: it is where the app opens, reached by
             * pressing back out of a page rather than by choosing it. A fifth
             * row would have pushed every real row down by 57.6 and made the
             * drawer claim a destination the reference does not offer.
             */
"""
s = s[:start] + new + s[end:]
open(p, "w", encoding="utf-8").write(s)
print("最近记录 removed from the drawer")