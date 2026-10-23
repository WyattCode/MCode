import io

path = "android/app/src/main/java/com/mcode/remote/MainActivity.kt"
s = io.open(path, encoding="utf-8").read()

old = '''                            Text(name, fontSize = 14.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
    /*
     * A file opens in its own sheet'''

new = '''                            Text(name, fontSize = 14.sp, color = LocalText.current, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }

    /*
     * A file opens in its own sheet'''

assert old in s, "closing braces not found"
s = s.replace(old, new, 1)
io.open(path, "w", encoding="utf-8").write(s)
print("braces restored")