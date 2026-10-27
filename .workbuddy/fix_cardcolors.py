p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) 卡片去掉填充，只留边框
old = """            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8), RoundedCornerShape(14.dp))
            .clickable { onClick() }
            .padding(12.dp),"""
new = """            .clip(RoundedCornerShape(14.dp))
            /*
             * No fill. Sampled inside the reference's own card at x 200 y 224:
             * (249,249,247) - the page's own colour. The card is a 1 dp outline
             * and nothing else, and the only thing darker on it is the
             * thumbnail well at (237,237,235). This filled with surface
             * (254,254,254), which made every record read as a white tile
             * floating above a grey page.
             */
            .border(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE1E1DF), RoundedCornerShape(14.dp))
            .clickable { onClick() }
            .padding(12.dp),"""
assert old in s, "card fill"
s = s.replace(old, new, 1)

# 2) 井换成参考里那一阶更深的颜色
old = """                .clip(RoundedCornerShape(8.dp))
                .background(LocalBg.current),
            contentAlignment = Alignment.Center,
        ) {"""
new = """                .clip(RoundedCornerShape(8.dp))
                .background(if (LocalBg.current == DarkBg) Color(0xFF262625) else Color(0xFFEDEDEB)),
            contentAlignment = Alignment.Center,
        ) {"""
assert old in s, "well fill"
s = s.replace(old, new, 1)

# 3) 文字块整体上移 6.4，两处间距各收 10.4 / 5.6
old = """        Spacer(Modifier.width(12.8.dp))
        Column {
            Spacer(Modifier.height(4.8.dp))
            Text("""
new = """        Spacer(Modifier.width(12.8.dp))
        /*
         * The three lines are placed by their own ink positions, not stacked
         * with equal spacers. Measured on the reference: title ink at 197.6,
         * 仅您可见 at 221.6, 编辑于 at 252.0 - that is 24.0 then 30.4 apart,
         * and the title sits 4.8 under the well's top.
         *
         * First build of this card: 34.4 and 36.0 apart, with the title's ink
         * 11.2 under the well instead of 4.8. So the offsets below come from
         * those four numbers - the block rides up 6.4, and the two gaps give up
         * 10.4 and 5.6.
         */
        Column(Modifier.offset(y = (-6.4).dp)) {
            Text("""
assert old in s, "column head"
s = s.replace(old, new, 1)

s = s.replace("""            Spacer(Modifier.height(10.4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {""",
              """            Spacer(Modifier.height(0.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {""", 1)

s = s.replace("""            Spacer(Modifier.height(12.dp))
            Text(
                "\\u7f16\\u8f91\\u4e8e \"""",
              """            Spacer(Modifier.height(6.4.dp))
            Text(
                "\\u7f16\\u8f91\\u4e8e \"""", 1)

# 4) 卡片间距 10 -> 8（参考卡片顶 180.8，搜索框底 160.4，差 20.4；实测 22.4）
s = s.replace("""                        ArtifactCard(row, now) { onOpen(row.root, row.path) }
                        Spacer(Modifier.height(10.dp))""",
              """                        ArtifactCard(row, now) { onOpen(row.root, row.path) }
                        Spacer(Modifier.height(8.dp))""", 1)

open(p, "w", encoding="utf-8").write(s)
print("card: outline only, well #EDEDEB, lines at 24.0/30.4")
