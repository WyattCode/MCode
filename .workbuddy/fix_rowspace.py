p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# Row 里的 Spacer(weight 1f) 把后面全挤没了；改成 SpaceBetween，
# 并去掉标题的层叠 align（它现在由 Box 居中的 Text 负责）。
old = """            Row(
                Modifier.fillMaxWidth().height(63.2.dp).padding(start = 1.6.dp, end = 4.4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {"""
new = """            /*
             * SpaceBetween, not a weight spacer.
             *
             * The Row had `Spacer(Modifier.weight(1f))` between the burger and
             * the two marks. Proved by painting the header red: that Row drew its
             * burger at x 15.6..31.6 and not one pixel of the title, the
             * magnifier or the filter, though all three sit in the same Row with
             * explicit 40 dp targets. A single weight child in a Row inside a
             * Box inside a weighted Column claimed the whole track.
             *
             * SpaceBetween needs no weight: burger, marks, marks, with the gaps
             * laid out by the arrangement, and the title is the Box's own centred
             * child.
             */
            Row(
                Modifier.fillMaxWidth().height(63.2.dp).padding(start = 1.6.dp, end = 4.4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {"""
assert old in s
s = s.replace(old, new, 1)

# 去掉中间的 weight spacer
s = s.replace("""                Spacer(Modifier.weight(1f))
                /*
                 * 搜索项目 and 筛选项目 are real:""",
              """                /*
                 * 搜索项目 and 筛选项目 are real:""", 1)

open(p, "w", encoding="utf-8").write(s)
print("header row: SpaceBetween, weight spacer removed")