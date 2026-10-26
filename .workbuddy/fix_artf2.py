p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
lines = open(p, encoding="utf-8").read().split("\n")

# 删除 11308..11344（筛选行 + 视图切换），保留 Spacer 和 item 闭合
start = None
for i in range(11300, 11312):
    if 'Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {' in lines[i]:
        start = i; break
assert start is not None, "filter row"
# 找闭合
depth = 0
end = None
for i in range(start, start+50):
    depth += lines[i].count('(') + lines[i].count('{') - lines[i].count(')') - lines[i].count('}')
    if i > start and depth <= 0:
        end = i; break
assert end is not None, "close"
print("removing lines %d..%d" % (start+1, end+1))

del lines[start:end+1]
lines.insert(start, """                /*
                 * No filter row and no layout toggle.
                 *
                 * The reference's artifacts page holds the search field and then
                 * its cards - measured, the field ends at 160.4 and the first
                 * card starts at 180.8, with nothing between. This put a row of
                 * category pills (全部 19 / 文档 5 / 应用 0 / 其他 …) and a
                 * grid-or-list switch in that 20 dp. Neither exists on the
                 * reference; the pills also cost a row of height on every visit.
                 */""")

open(p, "w", encoding="utf-8").write("\n".join(lines))
print("filter row removed")
