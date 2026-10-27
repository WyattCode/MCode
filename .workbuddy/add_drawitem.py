p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

anchor = """            /*
             * 「Code」, opening the conversation list - the reference's own
             * second row."""

new_item = """            /*
             * 最近记录, the reference's first row.
             *
             * Claude's drawer opens with four destinations - 项目, 最近记录,
             * Code, Artifacts, 定时任务 in that order once 最近记录 is counted -
             * and this rail had three: 项目, Code, Artifacts, 定时任务. The
             * missing one was the page the app opens on, so the rail had no row
             * for the screen the reader is looking at, and 最近记录 / Code were
             * fused into a single Sessions mode that carried a device panel the
             * home list should not have.
             */
            DrawerItem(
                Icons.Outlined.History,
                "最近记录",
                active = currentPage == LeftMode.Recent,
                path = "M3.4 11.4a8.6 8.6 0 1 1 2.6 6.2M3.4 7.2v4.4h4.4M12 8v4.6l3.2 2",
                pathStroke = 1.8f,
            ) { onRecent() }
            /*
             * 「Code」, opening the conversation list - the reference's own
             * second row."""

assert anchor in s, "anchor not found"
s = s.replace(anchor, new_item, 1)

# 加参数
old_param = """    /** The Code row: the conversation list, which is this app's own Code page. */
    onSessions: () -> Unit = {},"""
new_param = """    /** The Code row: the conversation list, which is this app's own Code page. */
    onSessions: () -> Unit = {},
    /** The 最近记录 row: the flat conversation list Claude opens on. */
    onRecent: () -> Unit = {},"""
assert old_param in s
s = s.replace(old_param, new_param, 1)

open(p, "w", encoding="utf-8").write(s)
print("drawer: added 最近记录 row")