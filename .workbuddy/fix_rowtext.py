p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 标题 15sp -> 18sp（注释自己写了 18，代码是 15）；flat 模式行高更紧
old = """                                Text(
                                    s.title.ifEmpty { s.id }.take(26),
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Medium,
                                    lineHeight = 20.sp,
                                    color = LocalText.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )"""
new = """                                Text(
                                    s.title.ifEmpty { s.id }.take(26),
                                    /*
                                     * 18sp, which the comment here already said.
                                     *
                                     * "Measured: Main's cap height is 12.4 dp and
                                     * the CJK title 15.2 - 18sp in this face,
                                     * where the 16 here drew 14.4" - and the code
                                     * then passed 15. Photographed against the
                                     * home list, the title ink is 12.8 against
                                     * this row's 11.2.
                                     */
                                    fontSize = if (flat) 18.sp else 15.sp,
                                    fontWeight = FontWeight.Medium,
                                    lineHeight = if (flat) 22.sp else 20.sp,
                                    color = LocalText.current,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )"""
assert old in s
s = s.replace(old, new, 1)

# flat 的时间与标题之间要 10.0 的 air
old2 = """                            if (flat) {
                                Text(
                                    relTime(s.updated),
                                    fontSize = 12.5.sp,
                                    lineHeight = 15.sp,
                                    color = LocalMuted.current,
                                    modifier = Modifier.padding(top = 4.dp),
                                )"""
new2 = """                            if (flat) {
                                /*
                                 * 14sp, 10.0 above: the reference's title ink
                                 * ends at 186.4 and its time ink starts at
                                 * 196.4.
                                 */
                                Text(
                                    relTime(s.updated),
                                    fontSize = 14.sp,
                                    lineHeight = 17.sp,
                                    color = LocalMuted.current,
                                    modifier = Modifier.padding(top = 6.dp),
                                )"""
assert old2 in s
s = s.replace(old2, new2, 1)

open(p, "w", encoding="utf-8").write(s)
print("flat row: title 18sp, time 14sp, gap 10")