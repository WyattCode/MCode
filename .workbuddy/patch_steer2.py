import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                                        color = LocalBubbleText.current,
                                    )
                                } else if (item.text.isNotBlank()) {'''

new = '''                                        color = LocalBubbleText.current,
                                    )
                                    /*
                                     * A mid-turn message gets the desktop's note
                                     * under it - 「\u5df2\u63d2\u8bdd \u00b7 \u4f1a\u5c3d\u5feb\u5904\u7406」 - because a bubble
                                     * that simply appeared inside a running turn
                                     * gave no sign whether the model had heard it
                                     * or would act on it.
                                     */
                                    if (item.steered) {
                                        Text(
                                            "\u5df2\u63d2\u8bdd \u00b7 \u4f1a\u5c3d\u5feb\u5904\u7406",
                                            fontSize = 11.sp,
                                            color = LocalMuted.current,
                                            modifier = Modifier.align(Alignment.End).padding(top = 4.dp),
                                        )
                                    }
                                } else if (item.text.isNotBlank()) {'''

assert old in s, "user text block not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("steer note rendered")