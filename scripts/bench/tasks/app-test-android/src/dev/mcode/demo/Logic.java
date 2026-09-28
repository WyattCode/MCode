package dev.mcode.demo;

/** What the buttons compute, kept apart from the screen so a check can call it directly. */
public final class Logic {
  private Logic() {}

  public static int plus(int count) {
    return count + 1;
  }

  public static int minus(int count) {
    return count - 2;
  }

  public static String savedText(String nick, boolean dark) {
    String name = nick == null || nick.trim().isEmpty() ? "（未填昵称）" : nick.trim();
    return "已保存：" + name + "，" + (dark ? "浅色" : "深色");
  }
}
