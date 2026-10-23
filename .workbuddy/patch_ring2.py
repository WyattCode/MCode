import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

# Define the two names the ring uses, right where the header reads the session.
old = '''                                val where = sessions.find { it.id == currentSession }?.directory.orEmpty()'''

new = '''                                val where = sessions.find { it.id == currentSession }?.directory.orEmpty()
                                val runningNow = sessions.find { it.id == currentSession }?.running == true
                                // The header's own stop: the same abort the
                                // composer's round button sends.
                                val stopHere: (String) -> Unit = { sid ->
                                    request(JSONObject().put("type", "session.abort").put("sessionID", sid))
                                }'''

assert old in s, "where clause not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("runningNow + stopHere defined")