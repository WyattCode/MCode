p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) 删掉空装饰方块（8925）
old1 = """                        if (!compact) {
                            Box(
                                Modifier
                                    .size(36.dp)
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(LocalCardTile.current),
                            )
                        }"""
new1 = """                        /*
                         * No tile behind the mark.
                         *
                         * Sampled the reference's card at the mark's own
                         * position: (249,249,247) - the page's colour, all the
                         * way through. There is no grey square there, only the
                         * mark itself and whatever the mark is made of. This
                         * drew a 36 dp rounded square first and then the glyph on
                         * top, which is why the column read as a list of tiles
                         * beside a reference that reads as a list of lines.
                         */"""
assert old1 in s
s = s.replace(old1, new1, 1)

# 2) spinner 的 Box 去掉尺寸限制与背景，只留图标本身
old2 = """                            Box(
                                Modifier
                                    .size(36.dp)
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(LocalCardTile.current),
                                contentAlignment = Alignment.Center,
                            ) {"""
new2 = """                            Box(
                                Modifier.size(36.dp),
                                contentAlignment = Alignment.Center,
                            ) {"""
assert old2 in s
s = s.replace(old2, new2, 1)

open(p, "w", encoding="utf-8").write(s)
print("tile background removed from both marks")