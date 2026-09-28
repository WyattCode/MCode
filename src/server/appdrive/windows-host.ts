/**
 * The program that reads and operates native Windows apps for the app tool:
 * Windows PowerShell hosting a small C# class over UI Automation - the same
 * interface screen readers use, so a button, a tab or a text box is found by
 * what it is and what it is called, not by where its pixels are.
 *
 * Kept as source text and written to a temp file when first needed, so
 * nothing extra has to ship beside app.asar. It is Windows PowerShell 5.1
 * (in every Windows 10 and 11), because that is where the .NET Framework's UI
 * Automation client and a C# compiler (Add-Type) come for free.
 *
 * Protocol: one JSON request per line on stdin ({id, op, ...}), one JSON
 * answer per line on stdout ({id, result} or {id, error}). The first line out
 * is {"ready":true}.
 *
 * No backquote and no dollar-brace anywhere below: this is a template string
 * here, and a backquote is PowerShell's escape character there.
 */
export const WINDOWS_HOST = String.raw`
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$assemblies = @("UIAutomationClient", "UIAutomationTypes", "System.Windows.Forms", "System.Web.Extensions", "System.Drawing", "WindowsBase")
foreach ($name in $assemblies) { Add-Type -AssemblyName $name }
$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Web.Script.Serialization;

public static class McodeUia {
  static AutomationElement window;
  static int windowPid;
  static Dictionary<string, int> ids = new Dictionary<string, int>();
  static Dictionary<int, AutomationElement> known = new Dictionary<int, AutomationElement>();
  static int next = 1;
  static JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

  /*
   * Nothing here takes the user's mouse, keyboard or foreground window: the
   * user keeps working while the app is driven. Controls are operated through
   * what they offer (UI Automation patterns); where one offers nothing, the
   * mouse or key message is posted to the control's own window, which does
   * not move the pointer or bring anything forward.
   */
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr handle, ref POINT point);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, IntPtr processId);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScan(char character);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, StringBuilder lParam);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr handle);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr handle);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

  /*
   * UI Automation reports where controls are in real pixels. A process that
   * does not say it knows about display scaling has its own coordinates scaled
   * by Windows, and a click placed from one onto the other lands beside its
   * control - on a 150% display, on the next tab along.
   */
  static McodeUia() { SetProcessDPIAware(); }

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret; }

  const uint WM_SETTEXT = 0x000C, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
  const uint WM_COMMAND = 0x0111, CB_GETCOUNT = 0x0146, CB_GETLBTEXT = 0x0148, CB_GETLBTEXTLEN = 0x0149, CB_SETCURSEL = 0x014E, CBN_SELCHANGE = 1;
  const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_LBUTTONDBLCLK = 0x0203, WM_MOUSEWHEEL = 0x020A;
  /// Shown in its last size and place, without being made the active window.
  const int SW_SHOWNOACTIVATE = 4;
  /// Where the last text was typed, which is where a key pressed next goes.
  static IntPtr typedInto = IntPtr.Zero;

  public static string Handle(string line) {
    object id = null;
    try {
      var request = (Dictionary<string, object>)json.DeserializeObject(line);
      id = request.ContainsKey("id") ? request["id"] : null;
      object result = Dispatch(request);
      return json.Serialize(new Dictionary<string, object> { { "id", id }, { "result", result } });
    } catch (Exception error) {
      var inner = error is System.Reflection.TargetInvocationException && error.InnerException != null ? error.InnerException : error;
      string message = inner is ElementNotAvailableException ? "gone" : inner.Message;
      return json.Serialize(new Dictionary<string, object> { { "id", id }, { "error", message } });
    }
  }

  static string Text(Dictionary<string, object> request, string key) {
    return request.ContainsKey(key) && request[key] != null ? Convert.ToString(request[key]) : "";
  }

  static int Number(Dictionary<string, object> request, string key) {
    return request.ContainsKey(key) && request[key] != null ? Convert.ToInt32(request[key]) : 0;
  }

  static object Dispatch(Dictionary<string, object> request) {
    switch (Text(request, "op")) {
      case "windows": return Windows(Number(request, "recent"), request.ContainsKey("own") && Convert.ToBoolean(request["own"]));
      case "attach": return Attach(Text(request, "match"), Number(request, "pid"));
      case "snapshot": return Snapshot(Math.Max(1, Number(request, "limit")));
      case "act": return Act(Text(request, "action"), Number(request, "ref"), Text(request, "text"), Number(request, "vk"), Text(request, "mods"), Text(request, "value"), Number(request, "dy"));
      case "settle": return Settle(Number(request, "quiet"), Number(request, "cap"));
      case "screenshot": return Screenshot(Text(request, "file"));
      case "alive": return window != null && Alive(window);
      case "front": return GetForegroundWindow().ToInt64();
      case "restore-front": {
        long handle = Convert.ToInt64(request["handle"]);
        if (handle != 0 && window != null && ProcessOf(GetForegroundWindow()) == (uint)windowPid) SetForegroundWindow(new IntPtr(handle));
        return true;
      }
      default: throw new Exception("unknown op");
    }
  }

  // ------------------------------------------------------------ windows

  /// Top-level windows: only the attached program's (own), or only those of programs started in the last RECENT seconds - never the whole desktop, whose titles are the user's business.
  static object Windows(int recent, bool own) {
    var list = new List<object>();
    foreach (AutomationElement top in AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition)) {
      try {
        var current = top.Current;
        if (string.IsNullOrWhiteSpace(current.Name)) continue;
        if (own && current.ProcessId != windowPid) continue;
        string process = "";
        try {
          var program = Process.GetProcessById(current.ProcessId);
          process = program.ProcessName;
          if (!own && (DateTime.Now - program.StartTime).TotalSeconds > recent) continue;
        } catch { if (!own) continue; }
        list.Add(new Dictionary<string, object> { { "id", current.NativeWindowHandle.ToString() }, { "title", current.Name }, { "process", process }, { "pid", current.ProcessId }, { "current", window != null && SameElement(top, window) } });
      } catch { }
    }
    return list;
  }

  static object Attach(string match, int pid) {
    AutomationElement found = null;
    var candidates = new List<AutomationElement>();
    foreach (AutomationElement top in AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition)) candidates.Add(top);
    foreach (var top in candidates) {
      try {
        var current = top.Current;
        if (current.IsOffscreen && !IsIconic(new IntPtr(current.NativeWindowHandle))) continue;
        if (pid > 0 && current.ProcessId != pid) continue;
        if (!string.IsNullOrEmpty(match)) {
          string process = "";
          try { process = Process.GetProcessById(current.ProcessId).ProcessName; } catch { }
          bool hit = current.Name.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0 || string.Equals(process, match, StringComparison.OrdinalIgnoreCase) || current.NativeWindowHandle.ToString() == match;
          if (!hit) continue;
        } else if (string.IsNullOrWhiteSpace(current.Name)) continue;
        found = top;
        break;
      } catch { }
    }
    if (found == null) throw new Exception("no-window");
    // A minimised window lists nothing: it is restored first, as a person would before using it.
    var handle = new IntPtr(found.Current.NativeWindowHandle);
    if (IsIconic(handle)) { ShowWindow(handle, SW_SHOWNOACTIVATE); Thread.Sleep(300); }
    window = found;
    windowPid = found.Current.ProcessId;
    ids.Clear();
    known.Clear();
    next = 1;
    return new Dictionary<string, object> { { "title", found.Current.Name }, { "pid", windowPid } };
  }

  static bool Alive(AutomationElement element) {
    try { var name = element.Current.Name; return true; } catch { return false; }
  }

  static bool SameElement(AutomationElement a, AutomationElement b) {
    try { return Automation.Compare(a, b); } catch { return false; }
  }

  /// A dialog the app is showing over its window - a message box, a file picker - takes the listing, as it takes the user's input.
  static AutomationElement Modal() {
    var condition = new PropertyCondition(AutomationElement.ProcessIdProperty, windowPid);
    foreach (AutomationElement top in AutomationElement.RootElement.FindAll(TreeScope.Children, condition)) {
      if (SameElement(top, window)) continue;
      if (IsDialog(top)) return top;
    }
    foreach (AutomationElement child in window.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window))) {
      if (IsDialog(child)) return child;
    }
    return null;
  }

  static bool IsDialog(AutomationElement element) {
    try {
      var current = element.Current;
      if (current.IsOffscreen) return false;
      if (current.ClassName == "#32770") return true;
      object pattern;
      if (element.TryGetCurrentPattern(WindowPattern.Pattern, out pattern)) return ((WindowPattern)pattern).Current.IsModal;
    } catch { }
    return false;
  }

  // ------------------------------------------------------------ reading

  static readonly Dictionary<ControlType, string> Roles = new Dictionary<ControlType, string> {
    { ControlType.Button, "button" }, { ControlType.SplitButton, "button" }, { ControlType.CheckBox, "checkbox" }, { ControlType.RadioButton, "radio" },
    { ControlType.ComboBox, "combobox" }, { ControlType.Edit, "textbox" }, { ControlType.Hyperlink, "link" }, { ControlType.ListItem, "option" },
    { ControlType.MenuItem, "menuitem" }, { ControlType.TabItem, "tab" }, { ControlType.TreeItem, "treeitem" }, { ControlType.Slider, "slider" },
    { ControlType.Spinner, "spinbutton" }, { ControlType.DataItem, "cell" }, { ControlType.HeaderItem, "columnheader" }, { ControlType.Document, "textbox" },
  };

  class Seen {
    public List<string> Lines = new List<string>();
    public List<string> Text = new List<string>();
    public HashSet<string> TextSeen = new HashSet<string>();
    public int More;
    public int Limit;
    public int Visited;
  }

  static object Snapshot(int limit) {
    if (window == null) throw new Exception("not-attached");
    if (!Alive(window)) throw new Exception("window-closed");
    // Minimised since the last look - by the user, or by the app - it would list nothing; it is put back first.
    var handle = new IntPtr(window.Current.NativeWindowHandle);
    if (IsIconic(handle)) { ShowWindow(handle, SW_SHOWNOACTIVATE); Thread.Sleep(300); }
    var modal = Modal();
    var scope = modal ?? window;
    var seen = new Seen { Limit = limit };
    Walk(scope, seen, 0);
    return new Dictionary<string, object> {
      { "title", window.Current.Name }, { "url", "window://" + ProcessName() }, { "modal", modal != null ? (modal.Current.Name ?? "dialog") : "" },
      { "elements", seen.Lines }, { "more", seen.More }, { "text", seen.Text },
    };
  }

  static string ProcessName() {
    try { return Process.GetProcessById(windowPid).ProcessName; } catch { return "app"; }
  }

  static void Walk(AutomationElement parent, Seen seen, int depth) {
    if (depth > 40 || seen.Visited > 4000) return;
    var walker = TreeWalker.ControlViewWalker;
    AutomationElement child;
    try { child = walker.GetFirstChild(parent); } catch { return; }
    while (child != null) {
      seen.Visited++;
      bool descend = Visit(child, seen);
      if (descend) Walk(child, seen, depth + 1);
      try { child = walker.GetNextSibling(child); } catch { child = null; }
    }
  }

  /// Lists one element if it can be acted on, keeps its text if it only says something; answers whether to look inside it.
  static bool Visit(AutomationElement element, Seen seen) {
    AutomationElement.AutomationElementInformation current;
    try { current = element.Current; } catch { return false; }
    var type = current.ControlType;
    // The title bar's own buttons and system menu belong to Windows, not the app; Alt+F4 still closes it.
    if (type == ControlType.TitleBar) return false;
    if (type == ControlType.Text || type == ControlType.StatusBar) {
      Keep(seen, current.Name);
      return false;
    }
    string role;
    bool interactive = Roles.TryGetValue(type, out role);
    if (!interactive && (bool)element.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty)) { interactive = true; role = "clickable"; }
    if (!interactive) return true;
    if (seen.Lines.Count >= seen.Limit) { seen.More++; return false; }
    int number = RefOf(element);
    var states = States(element, current, role);
    seen.Lines.Add("[" + number + "] " + role + " " + json.Serialize(NameOf(element, current)) + (states.Count > 0 ? " " + string.Join(" ", states) : ""));
    // A closed combo box's list is not on screen; an open one's items are.
    if (type == ControlType.ComboBox) return states.Contains("expanded");
    return type != ControlType.Button && type != ControlType.CheckBox && type != ControlType.RadioButton && type != ControlType.Edit && type != ControlType.Hyperlink;
  }

  static void Keep(Seen seen, string text) {
    text = (text ?? "").Trim();
    if (text.Length == 0 || seen.TextSeen.Contains(text) || seen.Text.Count >= 80) return;
    if (text.Length > 160) text = text.Substring(0, 159) + "…";
    seen.TextSeen.Add(text);
    seen.Text.Add(text);
  }

  static int RefOf(AutomationElement element) {
    string key = string.Join(".", element.GetRuntimeId());
    int number;
    if (!ids.TryGetValue(key, out number)) {
      number = next++;
      ids[key] = number;
    }
    known[number] = element;
    return number;
  }

  static string NameOf(AutomationElement element, AutomationElement.AutomationElementInformation current) {
    string name = current.Name;
    if (string.IsNullOrWhiteSpace(name)) {
      try { var label = current.LabeledBy; if (label != null) name = label.Current.Name; } catch { }
    }
    if (string.IsNullOrWhiteSpace(name)) name = current.HelpText;
    if (string.IsNullOrWhiteSpace(name)) name = current.AutomationId;
    name = (name ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
    return name.Length > 80 ? name.Substring(0, 79) + "…" : name;
  }

  static List<string> States(AutomationElement element, AutomationElement.AutomationElementInformation current, string role) {
    var states = new List<string>();
    if (!current.IsEnabled) states.Add("disabled");
    object pattern;
    if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern) && ((TogglePattern)pattern).Current.ToggleState == ToggleState.On) states.Add("checked");
    if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern) && ((SelectionItemPattern)pattern).Current.IsSelected) states.Add("selected");
    if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) {
      var state = ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState;
      if (state == ExpandCollapseState.Expanded) states.Add("expanded");
      else if (state == ExpandCollapseState.Collapsed && role != "combobox") states.Add("collapsed");
    }
    if (current.HasKeyboardFocus && role == "textbox") states.Add("focused");
    if ((role == "textbox" || role == "combobox" || role == "slider" || role == "spinbutton") && element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
      string value = ((ValuePattern)pattern).Current.Value ?? "";
      if (value.Length > 40) value = value.Substring(0, 39) + "…";
      states.Add("value=" + json.Serialize(value));
    } else if (role == "combobox" && element.TryGetCurrentPattern(SelectionPattern.Pattern, out pattern)) {
      var chosen = ((SelectionPattern)pattern).Current.GetSelection();
      states.Add("value=" + json.Serialize(chosen.Length > 0 ? chosen[0].Current.Name : ""));
    }
    if (current.IsOffscreen) states.Add("offscreen");
    return states;
  }

  // ------------------------------------------------------------ acting

  static AutomationElement Element(int number) {
    AutomationElement element;
    if (!known.TryGetValue(number, out element)) throw new Exception("unknown");
    if (!Alive(element)) throw new Exception("gone");
    return element;
  }

  /*
   * The user's foreground window, as it was before an action. Operating a
   * control through UI Automation lets the app activate itself - measured on
   * WinForms, a tab selected, a box ticked or a button invoked brings its
   * window to the front - and an app started from the foreground app (MCode,
   * while the user talks to it) is allowed to. So the window in front before
   * the action is put back in front after it, if the app took its place.
   */
  static IntPtr userFront = IntPtr.Zero;

  static uint ProcessOf(IntPtr handle) {
    uint process;
    GetWindowThreadProcessId(handle, out process);
    return process;
  }

  static void NoteFront() {
    var front = GetForegroundWindow();
    userFront = front != IntPtr.Zero && ProcessOf(front) != (uint)windowPid ? front : IntPtr.Zero;
  }

  static object GiveBack() {
    if (userFront == IntPtr.Zero || window == null) return false;
    var front = GetForegroundWindow();
    if (front == userFront || ProcessOf(front) != (uint)windowPid) return false;
    SetForegroundWindow(userFront);
    return true;
  }

  static object Act(string action, int number, string text, int vk, string mods, string value, int dy) {
    if (window == null) throw new Exception("not-attached");
    NoteFront();
    try { return Perform(action, number, text, vk, mods, value, dy); } finally { GiveBack(); }
  }

  static object Perform(string action, int number, string text, int vk, string mods, string value, int dy) {
    switch (action) {
      case "click": return Click(Element(number), 1);
      case "double_click": return Click(Element(number), 2);
      case "hover": PostMouse(Element(number), WM_MOUSEMOVE, 0); return "";
      case "type": return Type(Element(number), text);
      case "press": return Press(number > 0 ? NearestHandle(Element(number)) : KeyTarget(), vk, text, mods ?? "");
      case "select": return Choose(Element(number), value);
      case "scroll": return Scroll(number, dy == 0 ? 600 : dy);
      default: throw new Exception("unknown action");
    }
  }

  /// The control's own window, or the nearest one above it: WPF and other windowless controls live inside their host's.
  static IntPtr NearestHandle(AutomationElement element) {
    var walker = TreeWalker.RawViewWalker;
    var at = element;
    for (int depth = 0; at != null && depth < 50; depth++) {
      try {
        int handle = at.Current.NativeWindowHandle;
        if (handle != 0) return new IntPtr(handle);
        at = walker.GetParent(at);
      } catch { break; }
    }
    return new IntPtr(window.Current.NativeWindowHandle);
  }

  /// Where a key goes when no element is named: the last field typed into, else the control that has focus inside the app, else its window.
  static IntPtr KeyTarget() {
    if (typedInto != IntPtr.Zero) return typedInto;
    var top = new IntPtr(window.Current.NativeWindowHandle);
    var info = new GUITHREADINFO();
    info.cbSize = Marshal.SizeOf(info);
    if (GetGUIThreadInfo(GetWindowThreadProcessId(top, IntPtr.Zero), ref info) && info.hwndFocus != IntPtr.Zero) return info.hwndFocus;
    return top;
  }

  static IntPtr Where(int x, int y) { return new IntPtr((y << 16) | (x & 0xFFFF)); }

  /// A click or a move posted to the control's window at its middle - the pointer itself stays where the user left it.
  static void PostMouse(AutomationElement element, uint message, int count) {
    var at = Middle(element);
    var handle = NearestHandle(element);
    var point = new POINT { X = at.X, Y = at.Y };
    ScreenToClient(handle, ref point);
    var where = Where(point.X, point.Y);
    PostMessage(handle, WM_MOUSEMOVE, IntPtr.Zero, where);
    for (int i = 0; i < count; i++) {
      PostMessage(handle, i == 1 ? WM_LBUTTONDBLCLK : WM_LBUTTONDOWN, new IntPtr(1), where);
      PostMessage(handle, WM_LBUTTONUP, IntPtr.Zero, where);
    }
  }

  static IntPtr KeyParam(int vk, bool up) {
    uint scan = MapVirtualKey((uint)vk, 0);
    uint bits = 1u | (scan << 16) | (up ? 0xC0000000u : 0u);
    return new IntPtr(unchecked((int)bits));
  }

  /// A key posted to a window, with its character when it types one: the app reads it as a key press, and the user's own typing goes on elsewhere.
  static object Press(IntPtr target, int vk, string text, string mods) {
    bool ctrl = mods.Contains("ctrl"), alt = mods.Contains("alt"), shift = mods.Contains("shift");
    if (vk == 0 && !string.IsNullOrEmpty(text)) vk = VkKeyScan(text[0]) & 0xFF;
    uint down = alt ? WM_SYSKEYDOWN : WM_KEYDOWN, up = alt ? WM_SYSKEYUP : WM_KEYUP;
    if (ctrl) PostMessage(target, WM_KEYDOWN, new IntPtr(0x11), KeyParam(0x11, false));
    if (shift) PostMessage(target, WM_KEYDOWN, new IntPtr(0x10), KeyParam(0x10, false));
    if (alt) PostMessage(target, WM_SYSKEYDOWN, new IntPtr(0x12), KeyParam(0x12, false));
    PostMessage(target, down, new IntPtr(vk), KeyParam(vk, false));
    if (!string.IsNullOrEmpty(text) && !ctrl && !alt) foreach (char c in text) PostMessage(target, WM_CHAR, new IntPtr(c), KeyParam(vk, false));
    PostMessage(target, up, new IntPtr(vk), KeyParam(vk, true));
    if (alt) PostMessage(target, WM_SYSKEYUP, new IntPtr(0x12), KeyParam(0x12, true));
    if (shift) PostMessage(target, WM_KEYUP, new IntPtr(0x10), KeyParam(0x10, true));
    if (ctrl) PostMessage(target, WM_KEYUP, new IntPtr(0x11), KeyParam(0x11, true));
    // Posted keys do not change what the keyboard reports as held, so a shortcut only works in apps that read the message itself.
    return ctrl || alt ? "sent to the window without taking the keyboard; if nothing happened, the app reads held keys from the keyboard, so use a button or menu item instead" : "";
  }

  /// Scrolls without the wheel: the element into view, or the window's first scrollable part by pages.
  static object Scroll(int number, int dy) {
    object pattern;
    if (number > 0) {
      var element = Element(number);
      if (element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pattern)) ((ScrollItemPattern)pattern).ScrollIntoView();
      return "";
    }
    var scrollable = window.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.IsScrollPatternAvailableProperty, true));
    if (scrollable != null && scrollable.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern)) {
      ((ScrollPattern)pattern).ScrollVertical(dy > 0 ? ScrollAmount.LargeIncrement : ScrollAmount.LargeDecrement);
      return "";
    }
    var top = new IntPtr(window.Current.NativeWindowHandle);
    var middle = Middle(window);
    PostMessage(top, WM_MOUSEWHEEL, new IntPtr((-(dy / 5) * 120 / 120) << 16), Where(middle.X, middle.Y));
    return "";
  }

  static string ClassOf(IntPtr handle) {
    var name = new StringBuilder(256);
    GetClassName(handle, name, name.Capacity);
    return name.ToString();
  }

  /*
   * Whether a control lives in a window of its own that takes Win32 messages -
   * Win32 and WinForms controls do. Text and a combo box's choice are set that
   * way, which does not activate the app. Clicks are not: some common controls
   * place a click by where the real pointer last was, not by the message.
   * WPF, Qt, Chromium and XAML draw their controls inside one window and are
   * left to the patterns.
   */
  static bool TakesMessages(AutomationElement element) {
    string name = ClassOf(NearestHandle(element));
    if (name.Length == 0) return false;
    foreach (var drawn in new[] { "HwndWrapper", "Qt", "Chrome_", "Windows.UI.", "DirectUI", "ApplicationFrame", "Mozilla", "SunAwt", "GlassWnd" }) {
      if (name.StartsWith(drawn, StringComparison.OrdinalIgnoreCase)) return false;
    }
    return true;
  }

  /*
   * Runs something the app handles before it answers, waiting until it has:
   * a slow handler reported as done would be read before it changed anything.
   * It runs aside because a click that opens a modal dialog does not return
   * until the dialog closes: once a dialog is up, the click has done what it
   * will do for now.
   */
  static string Aside(Action action) {
    var thread = new Thread(() => { try { action(); } catch { } }) { IsBackground = true };
    thread.Start();
    var clock = Stopwatch.StartNew();
    while (!thread.Join(100)) {
      if (clock.ElapsedMilliseconds > 300 && Modal() != null) return "";
      if (clock.ElapsedMilliseconds > 10000) return "the app is still busy with this click after 10s";
    }
    return "";
  }

  /// A person's click, the way the control itself offers: invoked, selected or toggled; posted mouse messages for what offers none of those.
  static object Click(AutomationElement element, int count) {
    var current = element.Current;
    if (!current.IsEnabled) return "it is disabled";
    if (current.ControlType == ControlType.ComboBox) throw new Exception("combobox");
    object pattern;
    if (count == 1) {
      if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) {
        var invoke = (InvokePattern)pattern;
        return Aside(() => invoke.Invoke());
      }
      if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { ((SelectionItemPattern)pattern).Select(); return ""; }
      if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return ""; }
      if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) {
        var expand = (ExpandCollapsePattern)pattern;
        if (expand.Current.ExpandCollapseState == ExpandCollapseState.Expanded) expand.Collapse(); else expand.Expand();
        return "";
      }
    }
    PostMouse(element, WM_LBUTTONDOWN, count);
    return "";
  }

  static object Type(AutomationElement element, string text) {
    object pattern;
    typedInto = NearestHandle(element);
    // A field with a window of its own takes its text as a message, which changes it without activating the app.
    if (element.Current.NativeWindowHandle != 0 && TakesMessages(element)) {
      SendMessage(typedInto, WM_SETTEXT, IntPtr.Zero, text);
      return "";
    }
    if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && !((ValuePattern)pattern).Current.IsReadOnly) {
      ((ValuePattern)pattern).SetValue(text);
      return "";
    }
    foreach (char c in text) PostMessage(typedInto, WM_CHAR, new IntPtr(c), new IntPtr(1));
    return "typed into the window as characters";
  }

  /// A Win32 or WinForms combo box: its items read and one chosen through its own messages, and its parent told, as the app hears a person's choice.
  static object ChooseByMessage(AutomationElement element, string wanted) {
    var handle = new IntPtr(element.Current.NativeWindowHandle);
    int count = SendMessage(handle, CB_GETCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32();
    var names = new List<string>();
    for (int i = 0; i < count && i < 500; i++) {
      int length = SendMessage(handle, CB_GETLBTEXTLEN, new IntPtr(i), IntPtr.Zero).ToInt32();
      var text = new StringBuilder(Math.Max(0, length) + 1);
      if (length > 0) SendMessage(handle, CB_GETLBTEXT, new IntPtr(i), text);
      names.Add(text.ToString());
    }
    int index = names.FindIndex(name => string.Equals(name, wanted, StringComparison.OrdinalIgnoreCase));
    if (index < 0) index = names.FindIndex(name => name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0);
    if (index < 0) throw new Exception("no-option:" + string.Join("|", names.Take(30)));
    SendMessage(handle, CB_SETCURSEL, new IntPtr(index), IntPtr.Zero);
    int id = GetDlgCtrlID(handle);
    SendMessage(GetParent(handle), WM_COMMAND, new IntPtr((int)(CBN_SELCHANGE << 16) | (id & 0xFFFF)), handle);
    return "chose " + json.Serialize(names[index]);
  }

  static object Choose(AutomationElement element, string wanted) {
    if (element.Current.NativeWindowHandle != 0 && TakesMessages(element) && ClassOf(new IntPtr(element.Current.NativeWindowHandle)).IndexOf("COMBOBOX", StringComparison.OrdinalIgnoreCase) >= 0) return ChooseByMessage(element, wanted);
    object pattern;
    var names = new List<string>();
    bool opened = false;
    if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) {
      var expand = (ExpandCollapsePattern)pattern;
      if (expand.Current.ExpandCollapseState != ExpandCollapseState.Expanded) { expand.Expand(); opened = true; Thread.Sleep(120); }
    }
    AutomationElement match = null;
    foreach (AutomationElement item in element.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem))) {
      string name = item.Current.Name ?? "";
      names.Add(name);
      if (match == null && string.Equals(name, wanted, StringComparison.OrdinalIgnoreCase)) match = item;
    }
    if (match == null) {
      foreach (AutomationElement item in element.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem))) {
        if ((item.Current.Name ?? "").IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) { match = item; break; }
      }
    }
    if (match == null) {
      if (opened) try { ((ExpandCollapsePattern)element.GetCurrentPattern(ExpandCollapsePattern.Pattern)).Collapse(); } catch { }
      throw new Exception("no-option:" + string.Join("|", names.Take(30)));
    }
    ((SelectionItemPattern)match.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();
    string chosen = match.Current.Name;
    if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) try { ((ExpandCollapsePattern)pattern).Collapse(); } catch { }
    return "chose " + json.Serialize(chosen);
  }

  static System.Drawing.Point Middle(AutomationElement element) {
    System.Windows.Point point;
    if (element.TryGetClickablePoint(out point)) return new System.Drawing.Point((int)point.X, (int)point.Y);
    var box = element.Current.BoundingRectangle;
    if (box.IsEmpty) throw new Exception("hidden");
    return new System.Drawing.Point((int)(box.Left + box.Width / 2), (int)(box.Top + box.Height / 2));
  }

  // ------------------------------------------------------------ waiting

  /// Waits until the window stops changing: the same listing twice, QUIET ms apart, or CAP ms gone by.
  static object Settle(int quiet, int cap) {
    var clock = Stopwatch.StartNew();
    string last = Fingerprint();
    long stableSince = clock.ElapsedMilliseconds;
    while (clock.ElapsedMilliseconds < cap) {
      Thread.Sleep(40);
      string now = Fingerprint();
      if (now != last) { last = now; stableSince = clock.ElapsedMilliseconds; continue; }
      if (clock.ElapsedMilliseconds - stableSince >= quiet) break;
    }
    GiveBack();
    return clock.ElapsedMilliseconds;
  }

  static string Fingerprint() {
    try {
      var snapshot = (Dictionary<string, object>)Snapshot(250);
      return json.Serialize(snapshot);
    } catch (Exception error) { return error.Message; }
  }

  // ------------------------------------------------------------ pictures

  /// The window as it draws itself (PrintWindow), not the screen where it is: what covers it - another app, the user's own work - is never in the picture.
  static object Screenshot(string file) {
    var box = window.Current.BoundingRectangle;
    if (box.IsEmpty) throw new Exception("hidden");
    var handle = new IntPtr(window.Current.NativeWindowHandle);
    using (var bitmap = new System.Drawing.Bitmap((int)box.Width, (int)box.Height)) {
      using (var graphics = System.Drawing.Graphics.FromImage(bitmap)) {
        var hdc = graphics.GetHdc();
        bool drawn = PrintWindow(handle, hdc, 2);
        graphics.ReleaseHdc(hdc);
        if (!drawn) throw new Exception("the window could not draw itself for a picture");
      }
      bitmap.Save(file, System.Drawing.Imaging.ImageFormat.Png);
    }
    return file;
  }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies $assemblies
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  [Console]::Out.WriteLine([McodeUia]::Handle($line))
  [Console]::Out.Flush()
}
`
