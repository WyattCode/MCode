p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

# 在状态行 Row 前插入 flat 分支：flat 显示时间，否则显示连接状态
old = """                            Row(
                                Modifier.padding(top = 3.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                MiIcon(
                                    "M5.6 7.4h12.8a1.2 1.2 0 0 1 1.2 1.2v7.4H4.4V8.6a1.2 1.2 0 0 1 1.2-1.2zM3.2 16h17.6v2a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1z","""

new = """                            /*
                             * Flat rows carry the time here; cards carry the link.
                             *
                             * Photographed, Claude's 最近记录 puts a grey 「4分钟前」
                             * under the title, aligned to the title's own left
                             * edge, and says nothing about connections - the
                             * 已连接 • Remote control line belongs to its Code
                             * page's cards. Drawing the connection line on both
                             * made the home list a column of status readouts.
                             */
                            if (flat) {
                                Text(
                                    relTime(s.updated),
                                    fontSize = 12.5.sp,
                                    lineHeight = 15.sp,
                                    color = LocalMuted.current,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                            } else Row(
                                Modifier.padding(top = 3.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                MiIcon(
                                    "M5.6 7.4h12.8a1.2 1.2 0 0 1 1.2 1.2v7.4H4.4V8.6a1.2 1.2 0 0 1 1.2-1.2zM3.2 16h17.6v2a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1z","""

assert old in s, "status row not found"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("flat rows: time instead of connection line")