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

  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);

  const uint LEFTDOWN = 0x02, LEFTUP = 0x04, WHEEL = 0x0800;

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
      case "act": return Act(Text(request, "action"), Number(request, "ref"), Text(request, "text"), Text(request, "key"), Text(request, "value"), Number(request, "dy"));
      case "settle": return Settle(Number(request, "quiet"), Number(request, "cap"));
      case "screenshot": return Screenshot(Text(request, "file"));
      case "alive": return window != null && Alive(window);
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
    if (IsIconic(handle)) { ShowWindow(handle, 9); Thread.Sleep(300); }
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
    if (IsIconic(handle)) { ShowWindow(handle, 9); Thread.Sleep(300); }
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

  static object Act(string action, int number, string text, string key, string value, int dy) {
    if (window == null) throw new Exception("not-attached");
    switch (action) {
      case "click": return Click(Element(number), 1);
      case "double_click": return Click(Element(number), 2);
      case "hover": { var at = Middle(Element(number)); SetCursorPos(at.X, at.Y); return ""; }
      case "type": return Type(Element(number), text);
      case "press": Front(); System.Windows.Forms.SendKeys.SendWait(key); return "";
      case "select": return Choose(Element(number), value);
      case "scroll": {
        if (number > 0) {
          object pattern;
          var element = Element(number);
          if (element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pattern)) ((ScrollItemPattern)pattern).ScrollIntoView();
          return "";
        }
        var middle = Middle(window);
        Front();
        SetCursorPos(middle.X, middle.Y);
        mouse_event(WHEEL, 0, 0, -(dy == 0 ? 600 : dy) / 5, UIntPtr.Zero);
        return "";
      }
      default: throw new Exception("unknown action");
    }
  }

  /// A person's click, done the way the control itself offers: invoked, selected or toggled; the mouse only for what offers none of those.
  static object Click(AutomationElement element, int count) {
    var current = element.Current;
    if (!current.IsEnabled) return "it is disabled";
    if (current.ControlType == ControlType.ComboBox) throw new Exception("combobox");
    object pattern;
    if (count == 1) {
      if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) {
        var invoke = (InvokePattern)pattern;
        /*
         * Invoke returns when the app has finished handling the click, so it
         * is waited for - a slow handler reported as done would be read before
         * it changed anything. It runs aside because a button that opens a
         * modal dialog does not return until the dialog closes: once a dialog
         * is up, the click has done what it will do for now.
         */
        var thread = new Thread(() => { try { invoke.Invoke(); } catch { } }) { IsBackground = true };
        thread.Start();
        var clock = Stopwatch.StartNew();
        while (!thread.Join(100)) {
          if (clock.ElapsedMilliseconds > 300 && Modal() != null) return "";
          if (clock.ElapsedMilliseconds > 10000) return "the app is still busy with this click after 10s";
        }
        return "";
      }
      if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { ((SelectionItemPattern)pattern).Select(); return ""; }
      if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { ((TogglePattern)pattern).Toggle(); return ""; }
      if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) {
        var expand = (ExpandCollapsePattern)pattern;
        if (expand.Current.ExpandCollapseState == ExpandCollapseState.Expanded) expand.Collapse(); else expand.Expand();
        return "";
      }
    }
    var at = Middle(element);
    Front();
    SetCursorPos(at.X, at.Y);
    for (int i = 0; i < count; i++) {
      mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
      mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }
    return "clicked with the mouse";
  }

  static object Type(AutomationElement element, string text) {
    object pattern;
    if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && !((ValuePattern)pattern).Current.IsReadOnly) {
      ((ValuePattern)pattern).SetValue(text);
      return "";
    }
    Front();
    element.SetFocus();
    System.Windows.Forms.SendKeys.SendWait("^a");
    System.Windows.Forms.SendKeys.SendWait(Escape(text));
    return "typed with the keyboard";
  }

  static string Escape(string text) {
    var built = new StringBuilder();
    foreach (char c in text) {
      if ("+^%~(){}[]".IndexOf(c) >= 0) built.Append('{').Append(c).Append('}');
      else built.Append(c);
    }
    return built.ToString();
  }

  static object Choose(AutomationElement element, string wanted) {
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

  /// The window the keyboard and the mouse go to: restored if minimised, and brought forward.
  static void Front() {
    var handle = new IntPtr(window.Current.NativeWindowHandle);
    if (IsIconic(handle)) ShowWindow(handle, 9);
    SetForegroundWindow(handle);
    Thread.Sleep(50);
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
    return clock.ElapsedMilliseconds;
  }

  static string Fingerprint() {
    try {
      var snapshot = (Dictionary<string, object>)Snapshot(250);
      return json.Serialize(snapshot);
    } catch (Exception error) { return error.Message; }
  }

  // ------------------------------------------------------------ pictures

  static object Screenshot(string file) {
    var box = window.Current.BoundingRectangle;
    if (box.IsEmpty) throw new Exception("hidden");
    using (var bitmap = new System.Drawing.Bitmap((int)box.Width, (int)box.Height)) {
      using (var graphics = System.Drawing.Graphics.FromImage(bitmap)) graphics.CopyFromScreen((int)box.Left, (int)box.Top, 0, 0, bitmap.Size);
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
