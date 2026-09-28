// MCode's reader of an Android screen, kept running on the device while the app tool works.
//
// `uiautomator dump` starts a process and connects to the accessibility
// service every time it is asked - about two seconds a read. This connects
// once, the same way uiautomator does (its UiAutomationShellWrapper, found at
// run time in /system/framework/uiautomator.jar), and then answers every
// "dump" line on stdin with the window hierarchy on one line of stdout, in
// uiautomator's own XML shape so the reading side needs nothing new.
//
// Built by scripts/android-agent.mjs into a .dex that ships inside MCode, and
// run by the driver as:
//   CLASSPATH=<dex>:/system/framework/uiautomator.jar app_process / McodeAgent

import android.app.UiAutomation;
import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;

public class McodeAgent {
  public static void main(String[] args) throws Exception {
    Class<?> wrapperClass = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
    Object wrapper = wrapperClass.getDeclaredConstructor().newInstance();
    wrapperClass.getMethod("connect").invoke(wrapper);
    try {
      // Every view, as a plain `uiautomator dump` lists them, not only the ones marked important.
      wrapperClass.getMethod("setCompressedLayoutHeirarchy", boolean.class).invoke(wrapper, false);
    } catch (NoSuchMethodException ignored) {
    }
    UiAutomation ui = (UiAutomation) wrapperClass.getMethod("getUiAutomation").invoke(wrapper);
    PrintStream out = new PrintStream(System.out, true, "UTF-8");
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
    out.println("{\"ready\":true}");
    String line;
    while ((line = in.readLine()) != null) {
      line = line.trim();
      if (line.equals("quit")) break;
      if (!line.equals("dump")) continue;
      try {
        // Quiet for 150 ms, or two seconds gone: a screen still loading is read once it has settled, not mid-load.
        ui.waitForIdle(150, 2000);
      } catch (Exception ignored) {
        // Still animating after the cap: read it as it is now.
      }
      AccessibilityNodeInfo root = null;
      for (int attempt = 0; attempt < 10 && root == null; attempt++) {
        root = ui.getRootInActiveWindow();
        if (root == null) Thread.sleep(50);
      }
      StringBuilder xml = new StringBuilder("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
      if (root != null) write(root, xml, 0, 0);
      xml.append("</hierarchy>");
      out.println(xml);
    }
    wrapperClass.getMethod("disconnect").invoke(wrapper);
    System.exit(0);
  }

  private static void write(AccessibilityNodeInfo node, StringBuilder xml, int index, int depth) {
    if (depth > 60) return;
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    xml.append("<node index=\"").append(index).append('"');
    attr(xml, "text", node.getText());
    attr(xml, "resource-id", node.getViewIdResourceName());
    attr(xml, "class", node.getClassName());
    attr(xml, "package", node.getPackageName());
    attr(xml, "content-desc", node.getContentDescription());
    flag(xml, "checkable", node.isCheckable());
    flag(xml, "checked", node.isChecked());
    flag(xml, "clickable", node.isClickable());
    flag(xml, "enabled", node.isEnabled());
    flag(xml, "focusable", node.isFocusable());
    flag(xml, "focused", node.isFocused());
    flag(xml, "scrollable", node.isScrollable());
    flag(xml, "long-clickable", node.isLongClickable());
    flag(xml, "password", node.isPassword());
    flag(xml, "selected", node.isSelected());
    xml.append(" bounds=\"[").append(bounds.left).append(',').append(bounds.top).append("][").append(bounds.right).append(',').append(bounds.bottom).append("]\"");
    int count = node.getChildCount();
    if (count == 0) {
      xml.append("/>");
      return;
    }
    xml.append('>');
    for (int i = 0; i < count; i++) {
      AccessibilityNodeInfo child = node.getChild(i);
      if (child == null || !child.isVisibleToUser()) continue;
      write(child, xml, i, depth + 1);
    }
    xml.append("</node>");
  }

  private static void flag(StringBuilder xml, String name, boolean value) {
    xml.append(' ').append(name).append("=\"").append(value).append('"');
  }

  private static void attr(StringBuilder xml, String name, CharSequence value) {
    xml.append(' ').append(name).append("=\"");
    if (value != null) {
      String text = value.toString();
      for (int i = 0; i < text.length(); i++) {
        char c = text.charAt(i);
        switch (c) {
          case '&': xml.append("&amp;"); break;
          case '<': xml.append("&lt;"); break;
          case '>': xml.append("&gt;"); break;
          case '"': xml.append("&quot;"); break;
          case '\n': xml.append("&#10;"); break;
          case '\r': xml.append("&#13;"); break;
          default: xml.append(c);
        }
      }
    }
    xml.append('"');
  }
}
