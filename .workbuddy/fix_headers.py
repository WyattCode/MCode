p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 三处标题都用 fillMaxSize + wrapContentHeight，在 Box 里测出零高度。
# 主页那处已经踩过一次（标题整块不渲染），另外三页还是旧写法。
old_a = "                modifier = Modifier.fillMaxSize().wrapContentHeight().align(Alignment.Center).offset(x = 2.4.dp),"
new_a = """                /*
                 * A stated height, not fillMaxSize+wrapContentHeight.
                 *
                 * Those two fight in a fixed-height Box: fillMaxSize claims the
                 * whole 63.2 and wrapContentHeight then asks the text for its
                 * own, which resolved to nothing here - the title drew no ink at
                 * all and the header showed only its burger. Same fault as the
                 * home header two passes ago, in a second place.
                 */
                modifier = Modifier
                    .fillMaxWidth()
                    .height(63.2.dp)
                    .align(Alignment.Center)
                    .wrapContentHeight(Alignment.CenterVertically)
                    .offset(x = 2.4.dp),"""
n_a = s.count(old_a)
s = s.replace(old_a, new_a)

old_b = "                modifier = Modifier.fillMaxSize().wrapContentHeight().align(Alignment.Center).offset(x = (-5.2).dp),"
new_b = """                modifier = Modifier
                    .fillMaxWidth()
                    .height(63.2.dp)
                    .align(Alignment.Center)
                    .wrapContentHeight(Alignment.CenterVertically)
                    .offset(x = (-5.2).dp),"""
n_b = s.count(old_b)
s = s.replace(old_b, new_b)

open(p, "w", encoding="utf-8").write(s)
print("headers fixed: %d at +2.4, %d at -5.2" % (n_a, n_b))