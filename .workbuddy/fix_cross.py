p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                            Box(
                                Modifier
                                    .size(28.dp)
                                    .clip(RoundedCornerShape(14.dp))
                                    .clickable {
                                        search = ""
                                        searching = false
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                MiIcon(
                                    "M6.4 6.4L17.6 17.6M17.6 6.4L6.4 17.6",
                                    contentDescription = "关闭搜索",
                                    modifier = Modifier.size(11.dp),
                                    viewBox = 24f,
                                    strokeWidth = 2f,
                                    tint = LocalMuted.current,
                                )
                            }"""

new = """                            /*
                             * Only where the field had to be asked for.
                             *
                             * Claude's 最近记录 carries a plain field with nothing
                             * at its trailing end - sampled, the right side of
                             * the box is empty - because there the field is
                             * always there and has nothing to exit. The cross
                             * belongs to the Code page, where the field is a mode
                             * and a mode without an exit is a trap.
                             */
                            if (leftMode != LeftMode.Recent) Box(
                                Modifier
                                    .size(28.dp)
                                    .clip(RoundedCornerShape(14.dp))
                                    .clickable(
                                        interactionSource = remember { MutableInteractionSource() },
                                        indication = null,
                                    ) {
                                        search = ""
                                        searching = false
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                MiIcon(
                                    "M6.4 6.4L17.6 17.6M17.6 6.4L6.4 17.6",
                                    contentDescription = "关闭搜索",
                                    modifier = Modifier.size(11.dp),
                                    viewBox = 24f,
                                    strokeWidth = 2f,
                                    tint = LocalMuted.current,
                                )
                            }"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("search cross: Code only")