p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = "        LocalCardLine provides (if (dark) Color(0xFF232323) else Color(0xFFE1E1DF)),"
new = """        /*
         * The card's hairline is almost invisible: #F8F8F6 on a #F9F9F7 page.
         *
         * Measured off the reference's own card, whose edge pixels read
         * (248,248,246) against a (249,249,247) page - one step. Ours was
         * #E1E1DF, twenty-four steps down, which is why the cards read as
         * outlined boxes beside a reference that reads as soft panels with no
         * outline at all. The shape says "card"; the colour should not.
         */
        LocalCardLine provides (if (dark) Color(0xFF232323) else Color(0xFFF8F8F6)),"""
assert old in s, "card line colour not found"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("card hairline #E1E1DF -> #F8F8F6")