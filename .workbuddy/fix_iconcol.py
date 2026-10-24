p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                        Modifier
                            .width(if (compact) 31.2.dp else 36.dp)
                            .offset(y = if (compact) (-6.4).dp else 0.dp),"""
new = """                        Modifier
                            /*
                             * 23.6 on the flat list, 36 on the cards.
                             *
                             * Photographed: the home row's mark runs 26.0..37.6
                             * and its title starts at 49.6 - a 23.6 column off
                             * the row's 26.0 padding. The cards' 36 column is a
                             * different page's geometry, and using it here put
                             * the home title at 77.6 against 49.6.
                             */
                            .width(if (compact) 31.2.dp else if (flat) 23.6.dp else 36.dp)
                            .offset(y = if (compact) (-6.4).dp else 0.dp),"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("flat icon column: 36 -> 23.6")