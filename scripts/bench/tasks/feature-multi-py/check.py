import os
import shutil
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

work = tempfile.mkdtemp()
data = os.path.join(work, "data.json")
shutil.copy("data.json", data)
before = open("data.json", encoding="utf-8").read()


def run(*args, ok=True):
    result = subprocess.run([sys.executable, "-m", "todo", "--file", data, *args], capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    if ok:
        assert result.returncode == 0, (args, result.returncode, result.stderr)
    return result


lines = run("list").stdout.strip().splitlines()
assert lines == ["[ ] 1 (normal) 交房租", "[x] 2 (normal) 修自行车", "[ ] 3 (normal) 买牛奶"], lines

run("add", "报税", "--priority", "high")
run("add", "整理照片", "--priority", "low")
run("add", "回邮件")
run("done", "5")
lines = run("list").stdout.strip().splitlines()
assert lines == [
    "[ ] 4 (high) 报税",
    "[ ] 1 (normal) 交房租",
    "[x] 2 (normal) 修自行车",
    "[ ] 3 (normal) 买牛奶",
    "[ ] 6 (normal) 回邮件",
    "[x] 5 (low) 整理照片",
], lines

snapshot = open(data, encoding="utf-8").read()
bad = run("add", "乱写", "--priority", "urgent", ok=False)
assert bad.returncode == 2, bad.returncode
assert bad.stderr.strip(), "no message on stderr"
assert open(data, encoding="utf-8").read() == snapshot, "an invalid add changed the file"

assert open("data.json", encoding="utf-8").read() == before, "data.json was changed"
print("check passed")
