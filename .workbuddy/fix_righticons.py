p = r"D:/Documents/Claude Code/MCode/android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = open(p, encoding="utf-8").read()

old = """                        Box(Modifier.size(40.dp).clickable { leftMode = LeftMode.Scheduled }, contentAlignment = Alignment.Center) {
                            MiIcon(
                                /*
                                 * A ring with two hands, on the 24 grid: the
                                 * circle is drawn as an arc of 350 degrees so it
                                 * closes without a seam, and the hands meet at
                                 * the centre - 12 to 3, which is the reference's
                                 * own pose.
                                 */
                                "M12 0.9a11.1 11.1 0 1 0 0.01 0M12 6.2v6.2l4 2.5",
                                contentDescription = "定时任务",
                                modifier = Modifier.size(18.4.dp),
                                viewBox = 24f,
                                strokeWidth = 1.6f,
                                tint = LocalMuted.current,
                            )
                        }"""

new = """                        /*
                         * The trailing corner carries what the page needs.
                         *
                         * Photographed: 最近记录 puts a filter and a list there -
                         * glyphs at x 280.0..295.6 and 327.2..344.0, 31.6 apart -
                         * and Code puts a clock on its own. This drew the clock
                         * on both, so the home list offered 定时任务 where the
                         * reference offers a way to narrow and re-order the list
                         * in front of you.
                         */
                        if (leftMode == LeftMode.Recent) {
                            Box(
                                Modifier.size(40.dp).clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                ) { runningOnly = !runningOnly },
                                contentAlignment = Alignment.Center,
                            ) {
                                /*
                                 * A funnel with three tapering rules and a dot
                                 * at each end - the reference's own filter mark,
                                 * whose dots sit high on the outer rules and low
                                 * on the middle one.
                                 */
                                MiIcon(
                                    "M9.2 3.4h5.6M7.2 8.2h9.6M9.6 13h4.8",
                                    contentDescription = "筛选会话",
                                    modifier = Modifier.size(15.6.dp),
                                    viewBox = 24f,
                                    strokeWidth = 2f,
                                    tint = LocalMuted.current,
                                )
                            }
                            Box(
                                Modifier.size(40.dp).clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                ) { },
                                contentAlignment = Alignment.Center,
                            ) {
                                /* Three rules with a bullet each: the list view. */
                                MiIcon(
                                    "M4.6 5.6h2.8M10.4 5.6h13M4.6 12h2.8M10.4 12h13M4.6 18.4h2.8M10.4 18.4h13",
                                    contentDescription = "列表视图",
                                    modifier = Modifier.size(16.8.dp),
                                    viewBox = 24f,
                                    strokeWidth = 1.9f,
                                    tint = LocalMuted.current,
                                )
                            }
                        } else {
                            Box(
                                Modifier.size(40.dp).clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                ) { leftMode = LeftMode.Scheduled },
                                contentAlignment = Alignment.Center,
                            ) {
                                MiIcon(
                                    /*
                                     * A ring with two hands, on the 24 grid: the
                                     * circle is drawn as an arc of 350 degrees so
                                     * it closes without a seam, and the hands meet
                                     * at the centre - 12 to 3, the reference's pose.
                                     */
                                    "M12 0.9a11.1 11.1 0 1 0 0.01 0M12 6.2v6.2l4 2.5",
                                    contentDescription = "定时任务",
                                    modifier = Modifier.size(18.4.dp),
                                    viewBox = 24f,
                                    strokeWidth = 1.6f,
                                    tint = LocalMuted.current,
                                )
                            }
                        }"""
assert old in s
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
print("Recent: filter + list; Code: clock")