import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                                    DropdownMenuItem(
                                        text = { Text("\u91cd\u547d\u540d") },
                                        onClick = { headerMenu = false; renameTarget = sessions.find { it.id == currentSession } },
                                    )'''

new = '''                                    DropdownMenuItem(
                                        text = { Text("\u91cd\u547d\u540d") },
                                        onClick = { headerMenu = false; renameTarget = sessions.find { it.id == currentSession } },
                                    )
                                    /*
                                     * The desktop's undo: take the last turn's file
                                     * edits back. It had no phone counterpart at
                                     * all, so a turn that broke a file could only
                                     * be repaired by hand.
                                     */
                                    DropdownMenuItem(
                                        text = { Text("\u64a4\u9500\u4e0a\u4e00\u56de\u5408\u7684\u6539\u52a8") },
                                        onClick = {
                                            headerMenu = false
                                            currentSession?.let { sid ->
                                                request(JSONObject().put("type", "session.undo").put("sessionID", sid))
                                            }
                                        },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("\u91cd\u505a\u64a4\u9500") },
                                        onClick = {
                                            headerMenu = false
                                            currentSession?.let { sid ->
                                                request(JSONObject().put("type", "session.redo").put("sessionID", sid))
                                            }
                                        },
                                    )'''

assert old in s, "rename item not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("undo/redo in menu")