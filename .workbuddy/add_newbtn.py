p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                Text(
                    "让 Claude 按计划运行任务。",
                    fontSize = 13.sp,
                    lineHeight = 21.2.sp,
                    color = LocalMuted.current,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        } else {"""
new = """                Text(
                    "让 Claude 按计划运行任务。",
                    fontSize = 13.sp,
                    lineHeight = 21.2.sp,
                    color = LocalMuted.current,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
            /*
             * The page's own way in, at the foot.
             *
             * The reference puts a 「+ 新建任务」 capsule at y 832.8, x
             * 220.8..343.6 - 122.8 wide, the same box and the same right edge as
             * the list pages' 新建会话. This page had no such control at all: the
             * only way to make an automation was to leave for the conversation
             * list first, which is a door out of a page that had none in.
             */
            Box(Modifier.fillMaxWidth().padding(end = 16.4.dp, bottom = 32.4.dp), contentAlignment = Alignment.CenterEnd) {
                Row(
                    Modifier
                        .width(122.8.dp)
                        .height(43.6.dp)
                        .clip(RoundedCornerShape(21.8.dp))
                        .background(if (LocalBg.current == DarkBg) Color(0xFF2A2A29) else Color(0xFF1A1A19))
                        .clickable { onNew() },
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "+ 新建任务",
                        fontSize = 13.6.sp,
                        color = if (LocalBg.current == DarkBg) Color(0xFFF9F9F7) else Color(0xFFF9F9F7),
                    )
                }
            }
        } else {"""
assert old in s, "scheduled caption"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("scheduled: new-task capsule added")
