p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                        } else if (s.directory.isNotBlank()) {
                            MiIcon(
                                // Fills the grid: `M9 7…M19 17` inside 24 drew
                                // 7.2 of mark in an 11.6 box, where Claude's
                                // `</>` ink is 11.6 x 10.0.
                                "M6.4 5.2 1.6 12l4.8 6.8M17.6 5.2 22.4 12l-4.8 6.8M15.6 3.6 8.4 20.4",
                                modifier = Modifier.size(11.6.dp),
                                viewBox = 24f,
                                strokeWidth = 2.2f,
                                tint = LocalMuted.current,
                            )"""

new = """                        } else if (s.id == current) {
                            /*
                             * `</>` marks the conversation you are reading.
                             *
                             * Photographed in the drawer: Main - the open one -
                             * carries a code mark, and every other row carries a
                             * speech bubble, whether or not that conversation has
                             * a directory. This tested `directory.isNotBlank()`,
                             * so a project conversation wore the code mark and a
                             * plain one wore a bubble, and the mark said where a
                             * conversation lived rather than which one is on
                             * screen.
                             *
                             * Fills the grid: `M9 7…M19 17` inside 24 drew 7.2 of
                             * mark in an 11.6 box, where Claude's `</>` ink is
                             * 11.6 x 10.0.
                             */
                            MiIcon(
                                "M6.4 5.2 1.6 12l4.8 6.8M17.6 5.2 22.4 12l-4.8 6.8M15.6 3.6 8.4 20.4",
                                modifier = Modifier.size(11.6.dp),
                                viewBox = 24f,
                                strokeWidth = 2.2f,
                                tint = LocalMuted.current,
                            )"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("row mark: `</>` only for the open conversation")
pass