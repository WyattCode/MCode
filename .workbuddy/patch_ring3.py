import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# Remove the two definitions from inside the centred column.
old = '''                                val runningNow = sessions.find { it.id == currentSession }?.running == true
                                // The header's own stop: the same abort the
                                // composer's round button sends.
                                val stopHere: (String) -> Unit = { sid ->
                                    request(JSONObject().put("type", "session.abort").put("sessionID", sid))
                                }
'''
assert old in s, "inner defs not found"
s = s.replace(old, "", 1)

# Hoist them above the header Row so every child sees them.
anchor = '''                            Box(Modifier.size(44.dp).clickable { openDrawer() }, contentAlignment = Alignment.Center) {
                                Icon(Icons.AutoMirrored.Outlined.ArrowBack'''
assert anchor in s, "back arrow anchor not found"

hoisted = '''                            /*
                             * Read once for the whole header: the title needs the
                             * folder, and the clock's amber ring needs to know a
                             * turn is in flight (and how to stop it).
                             */
                            val runningNow = sessions.find { it.id == currentSession }?.running == true
                            val stopHere: (String) -> Unit = { sid ->
                                request(JSONObject().put("type", "session.abort").put("sessionID", sid))
                            }
'''
s = s.replace(anchor, hoisted + anchor, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("defs hoisted")