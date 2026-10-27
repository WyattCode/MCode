p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 1) SessionList 加 flat 参数
old_sig = """    compact: Boolean,
    modifier: Modifier = Modifier,
    onLongPress: ((SessionRow) -> Unit)? = null,"""
new_sig = """    compact: Boolean,
    modifier: Modifier = Modifier,
    /**
     * No card: a flat row on the page.
     *
     * Claude's 最近记录 list is rows on the page - icon, title, and a time under
     * it - with no plate and no hairline. Its Code page is the one that draws
     * cards. Same component, two skins, because the rows are otherwise
     * identical.
     */
    flat: Boolean = false,
    onLongPress: ((SessionRow) -> Unit)? = null,"""
assert old_sig in s, "sig"
s = s.replace(old_sig, new_sig, 1)

# 2) 卡片条件加 !flat
old_card = """                        .then(
                            if (compact) Modifier
                            else Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .background(LocalCard.current)
                                .border(1.dp, LocalCardHairline.current, RoundedCornerShape(12.dp)),
                        )"""
new_card = """                        .then(
                            if (compact || flat) Modifier
                            else Modifier
                                .clip(RoundedCornerShape(12.dp))
                                .background(LocalCard.current)
                                .border(1.dp, LocalCardHairline.current, RoundedCornerShape(12.dp)),
                        )"""
assert old_card in s, "card"
s = s.replace(old_card, new_card, 1)

# 3) Recent 用 flat
old_call = """                            else -> SessionList(
                                visibleSessions,
                                currentSession,
                                search,
                                onSelect = { select(it) },
                                compact = false,"""
new_call = """                            else -> SessionList(
                                visibleSessions,
                                currentSession,
                                search,
                                onSelect = { select(it) },
                                compact = false,
                                /*
                                 * 最近记录 is the flat one: no plate, no hairline,
                                 * just rows. Code is the page with cards.
                                 */
                                flat = leftMode == LeftMode.Recent,"""
assert old_call in s, "call"
s = s.replace(old_call, new_call, 1)

open(p, "w", encoding="utf-8").write(s)
print("SessionList: added flat flag; Recent renders flat")