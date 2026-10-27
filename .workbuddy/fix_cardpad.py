p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """@Composable
private fun ArtifactCard(row: ArtRow, now: Long, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8), RoundedCornerShape(14.dp))
            .clickable { onClick() }
            .padding(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier
                .width(155.2.dp)
                .height(86.4.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(LocalBg.current),
            contentAlignment = Alignment.Center,
        ) {"""

new = """@Composable
private fun ArtifactCard(row: ArtRow, now: Long, onClick: () -> Unit) {
    /*
     * The reference's record, measured off its own artifacts page at 400 dpi.
     *
     *   card    x 16.0..343.6   y 180.8..279.2   327.6 x 98.4
     *   well    x 28.0..140.0   y 192.8..267.6   112.0 x 74.8
     *   title   x 152.8..269.2  y 197.6..211.2
     *   lock    x 154.4..165.2, then 仅您可见 at 172.4..222.0, y 221.6..234.0
     *   edited  x 152.8..228.0  y 252.0..263.6
     *
     * Two of my earlier numbers were wrong and between them drew a card 14.4
     * taller than the reference's. The well is 112 x 74.8, not 155.2 x 86.4 -
     * a vertical scan at x=80dp puts its fill from 192.8 to 267.6 and a
     * horizontal one at y=224 puts its edges at 28.0 and 140.0. And the card's
     * inset is 12, from 16.0 to 28.0 and from 180.8 to 192.8, not 8.
     */
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, if (LocalBg.current == DarkBg) Color(0xFF2C2C2B) else Color(0xFFE4E1D8), RoundedCornerShape(14.dp))
            .clickable { onClick() }
            .padding(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier
                .width(112.dp)
                .height(74.8.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(LocalBg.current),
            contentAlignment = Alignment.Center,
        ) {"""

assert old in s, "card head"
s = s.replace(old, new, 1)

# 井里的符号随井缩小：30 -> 26
s = s.replace(
    "            Canvas(Modifier.size(30.dp)) { row.badge.glyph(this) }",
    "            Canvas(Modifier.size(26.dp)) { row.badge.glyph(this) }",
    1,
)

# 文字列间距 18.8 -> 12.8，并去掉 Column 的 top 内边距（改用显式 Spacer）
s = s.replace(
    """        Spacer(Modifier.width(18.8.dp))
        Column(Modifier.padding(top = 4.8.dp)) {
            Text(""",
    """        Spacer(Modifier.width(12.8.dp))
        Column {
            Spacer(Modifier.height(4.8.dp))
            Text(""",
    1,
)

# 锁图标 11.2 -> 10.8；与文字的间隙 4.4 -> 7.2
s = s.replace("Canvas(Modifier.size(11.2.dp)) {\n                    val ink = lockInk",
              "Canvas(Modifier.size(10.8.dp)) {\n                    val ink = lockInk", 1)
s = s.replace("Spacer(Modifier.width(4.4.dp))\n                Text(\"\\u4ec5\\u60a8\\u53ef\\u89c1\"",
              "Spacer(Modifier.width(7.2.dp))\n                Text(\"\\u4ec5\\u60a8\\u53ef\\u89c1\"", 1)

# 三行间距：标题->锁 10.8 -> 10.4；锁->时间 9.6 -> 12.0
s = s.replace("            Spacer(Modifier.height(10.8.dp))\n            Row(verticalAlignment = Alignment.CenterVertically) {",
              "            Spacer(Modifier.height(10.4.dp))\n            Row(verticalAlignment = Alignment.CenterVertically) {", 1)
s = s.replace("            Spacer(Modifier.height(9.6.dp))\n            Text(\n                \"\\u7f16\\u8f91\\u4e8e \"",
              "            Spacer(Modifier.height(12.dp))\n            Text(\n                \"\\u7f16\\u8f91\\u4e8e \"", 1)

open(p, "w", encoding="utf-8").write(s)
print("artifact card: well 112x74.8, inset 12, text gap 12.8")
