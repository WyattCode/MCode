p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                                Spacer(Modifier.weight(1f))
                                Text(
                                    relTime(s.updated),
                                    fontSize = 12.sp,
                                    lineHeight = 16.sp,
                                    color = LocalMuted.current,
                                )
                            }"""
new = """                                Spacer(Modifier.weight(1f))
                                /*
                                 * Cards put the time at the row's trailing end;
                                 * flat rows put it under the title instead.
                                 *
                                 * Claude's 最近记录 has no time on the title
                                 * line at all - it sits on the second line, left
                                 * aligned with the title. Keeping both drew the
                                 * word twice, once at each end.
                                 */
                                if (!flat) Text(
                                    relTime(s.updated),
                                    fontSize = 12.sp,
                                    lineHeight = 16.sp,
                                    color = LocalMuted.current,
                                )
                            }"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("flat: no time on the title line")