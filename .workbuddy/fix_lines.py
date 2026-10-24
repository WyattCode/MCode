p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) 恢复 LocalCardLine 为 E1E1DF（胶囊用）
old_theme = """        /*
         * The card's hairline is almost invisible: #F8F8F6 on a #F9F9F7 page.
         *
         * Measured off the reference's own card, whose edge pixels read
         * (248,248,246) against a (249,249,247) page - one step. Ours was
         * #E1E1DF, twenty-four steps down, which is why the cards read as
         * outlined boxes beside a reference that reads as soft panels with no
         * outline at all. The shape says "card"; the colour should not.
         */
        LocalCardLine provides (if (dark) Color(0xFF232323) else Color(0xFFF8F8F6)),"""
new_theme = """        /*
         * Two different hairlines, and they are not interchangeable.
         *
         * The conversation card's edge reads (248,248,246) on a (249,249,247)
         * page - one step, which is why the reference's cards look like soft
         * panels rather than outlined boxes. The 添加设备 capsule's edge reads
         * (225,225,223), twenty-four steps down, a line you can actually see.
         *
         * An earlier pass changed this one value to #F8F8F6 for the card's
         * sake and erased the capsule's outline along with it. The card now
         * uses LocalCardHairline; this stays for anything that really is drawn.
         */
        LocalCardLine provides (if (dark) Color(0xFF232323) else Color(0xFFE1E1DF)),
        /*
         * The card's near-invisible edge. See LocalCardLine above.
         */
        LocalCardHairline provides (if (dark) Color(0xFF2B2B2B) else Color(0xFFF8F8F6)),"""
assert old_theme in s
s = s.replace(old_theme, new_theme, 1)

# 2) 在 LocalCardLine 声明旁加 LocalCardHairline
old_decl = "val LocalCardLine = staticCompositionLocalOf { Color(0xFFE1E1DF) }"
new_decl = """val LocalCardLine = staticCompositionLocalOf { Color(0xFFE1E1DF) }

/**
 * The conversation card's edge, which the reference draws one step off the page.
 *
 * Kept apart from [LocalCardLine] because the two are not the same colour: the
 * card's is (248,248,246), the 添加设备 capsule's is (225,225,223). Sharing one
 * token made the capsule lose its outline the moment the card's was corrected.
 */
val LocalCardHairline = staticCompositionLocalOf { Color(0xFFF8F8F6) }"""
assert old_decl in s
s = s.replace(old_decl, new_decl, 1)

# 3) 会话卡改用 LocalCardHairline
old_card = ".border(1.dp, LocalCardLine.current, RoundedCornerShape(12.dp)),"
new_card = ".border(1.dp, LocalCardHairline.current, RoundedCornerShape(12.dp)),"
assert old_card in s
s = s.replace(old_card, new_card, 1)

open(p, "w", encoding="utf-8").write(s)
print("split: LocalCardLine #E1E1DF (capsule), LocalCardHairline #F8F8F6 (card)")