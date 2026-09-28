// The benchmark's judge: Logic.java compiled with a plain JDK and called directly - no device needed to decide.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const folder = path.dirname(fileURLToPath(import.meta.url))
const work = fs.mkdtempSync(path.join(os.tmpdir(), "check-"))
const bin = (name) => (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name)
try {
  fs.mkdirSync(path.join(work, "src"))
  fs.writeFileSync(
    path.join(work, "src", "LogicCheck.java"),
    `import dev.mcode.demo.Logic;
public class LogicCheck {
  static void expect(Object actual, Object wanted, String what) {
    if (!actual.equals(wanted)) { System.out.println("FAIL " + what + ": expected '" + wanted + "', got '" + actual + "'"); System.exit(1); }
  }
  public static void main(String[] args) {
    expect(Logic.plus(3), 4, "plus");
    expect(Logic.minus(5), 4, "minus subtracts one");
    expect(Logic.savedText("小王", true), "已保存：小王，深色", "dark mode checked says 深色");
    expect(Logic.savedText("", false), "已保存：（未填昵称），浅色", "unchecked says 浅色");
    System.out.println("check passed");
  }
}
`,
  )
  execFileSync(bin("javac"), ["-encoding", "UTF-8", "-d", work, path.join(folder, "src", "dev", "mcode", "demo", "Logic.java"), path.join(work, "src", "LogicCheck.java")], { stdio: "inherit" })
  const said = execFileSync(bin("java"), ["-Dstdout.encoding=UTF-8", "-cp", work, "LogicCheck"], { encoding: "utf8" })
  process.stdout.write(said)
  if (!said.includes("check passed")) process.exit(1)
} catch (error) {
  if (error.stdout) process.stdout.write(String(error.stdout))
  process.exit(1)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
