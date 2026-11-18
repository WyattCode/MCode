import AppKit
import ApplicationServices

func fail(_ reason: String) -> Never {
    FileHandle.standardError.write(Data(reason.utf8))
    exit(1)
}

let args = CommandLine.arguments
guard args.count == 5,
      let pid = Int32(args[1]),
      let x = Double(args[2]), x.isFinite,
      let y = Double(args[3]), y.isFinite,
      let count = Int(args[4]), (1...2).contains(count) else {
    fail("Invalid click arguments")
}
guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
    fail("Accessibility permission is required")
}
let point = CGPoint(x: x, y: y)
let bounds = CGDisplayBounds(CGMainDisplayID())
guard bounds.contains(point) else { fail("Coordinates are outside the primary display") }

for click in 1...count {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        fail("The requested application is no longer in front")
    }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    let covering = windows?.first { window in
        guard window[kCGWindowLayer as String] as? Int == 0,
              let rawBounds = window[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: rawBounds as CFDictionary) else { return false }
        return rect.contains(point)
    }
    guard covering?[kCGWindowOwnerPID as String] as? Int32 == pid else {
        fail("Coordinates do not hit a window of the requested application")
    }
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        fail("Could not create mouse events")
    }
    down.setIntegerValueField(.mouseEventClickState, value: Int64(click))
    up.setIntegerValueField(.mouseEventClickState, value: Int64(click))
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}
