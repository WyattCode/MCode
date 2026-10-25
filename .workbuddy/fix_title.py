p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 标题的 modifier：fillMaxSize + wrapContentHeight 在 Box 里测出了 0 高
old = """                            modifier = Modifier
                                .fillMaxSize()
                                .wrapContentHeight()
                                .align(Alignment.Center)
                                .offset(x = (-5.2).dp),"""
new = """                            /*
                             * A height, not `fillMaxSize().wrapContentHeight()`.
                             *
                             * Those two fight: fillMaxSize claims the Box's whole
                             * 63.2 and wrapContentHeight then asks the text for
                             * its own, which in a Box this size resolved to no
                             * height at all - the header drew nothing while the
                             * burger beside it drew fine. The bar's height is
                             * known, so it is stated.
                             */
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(63.2.dp)
                                .align(Alignment.Center)
                                .wrapContentHeight(Alignment.CenterVertically)
                                .offset(x = (-5.2).dp),"""
assert old in s
s = s.replace(old, new, 1)

# 标题文本显式转成 String，避开 if-链的类型推断
old2 = """                            if (leftMode == LeftMode.Recent) "最近记录"
                            else if (leftMode == LeftMode.Artifacts) "产物中心"
                            else "Code","""
new2 = """                            (
                                if (leftMode == LeftMode.Recent) "最近记录"
                                else if (leftMode == LeftMode.Artifacts) "产物中心"
                                else "Code"
                            ) as String,"""
assert old2 in s
s = s.replace(old2, new2, 1)

open(p, "w", encoding="utf-8").write(s)
print("header title: explicit height, explicit String")