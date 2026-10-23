import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                                        val rel = if (sub.isBlank()) name else "$sub/$name"
                                        val ticket = "fr${System.nanoTime()}"
                                        scope.launch {
                                            val deferred = client.awaitResponse(ticket)
                                            request(JSONObject().put("type", "file.read").put("root", root).put("rel", rel), ticket)
                                            val r = runCatching { deferred.await() }.getOrNull() ?: return@launch
                                            val body = r.optJSONObject("data")?.optString("content").orEmpty()
                                            filePreview = rel to body
                                        }'''

new = '''                                        val rel = if (sub.isBlank()) name else "$sub/$name"
                                        // `rpc` is the same round trip the rest of
                                        // this screen uses; the hand-rolled ticket
                                        // here never came back.
                                        scope.launch {
                                            val r = runCatching {
                                                rpc(JSONObject().put("type", "file.read").put("root", root).put("rel", rel))
                                            }.getOrNull() ?: return@launch
                                            val body = r.optJSONObject("data")?.optString("content").orEmpty()
                                            filePreview = rel to body
                                        }'''

assert old in s, "file click block not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("uses rpc now")