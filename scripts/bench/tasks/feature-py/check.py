import subprocess, sys

def run(*args):
    return subprocess.run([sys.executable, "inventory.py", *args], capture_output=True, text=True, check=True).stdout.strip().splitlines()

assert run("stock.csv") == ["widget: 12", "gadget: 3", "sprocket: 0", "gizmo: 7", "bolt: 2"], run("stock.csv")
low = run("stock.csv", "--low-stock", "5")
assert low == ["sprocket: 0", "bolt: 2", "gadget: 3"], low
assert run("stock.csv", "--low-stock", "1") == ["sprocket: 0"], run("stock.csv", "--low-stock", "1")
print("check passed")
