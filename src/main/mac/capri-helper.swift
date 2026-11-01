// Capri's eyes on your Mac: the windows, the Dock, your desktops, what you plug in, plus the few
// things that need a native call (closing an app, the media keys, the apps installed). Built by
// scripts/build-mac-helper.js.
//
//   capri-helper watch <overlay window id> <capri pid>
//       one JSON line whenever something changes: the window in front and the visible windows in
//       z-order (front first), in points, in the same coordinates as Electron's screen. No contents,
//       no titles: the title of the window in front (only readable with Screen Recording allowed)
//       is checked against a short list of AI names, and all that goes out is which of them matched.
//       Also the game in front, the USB sticks plugged in, the last device plugged in or out, the
//       Dock while it shows, how many times you changed desktop (Space), and whether her window is here.
//   capri-helper apps                   the apps running, as JSON
//   capri-helper installed              the apps installed, as JSON
//   capri-helper quit [--force] <pid>…  closes them like Cmd+Q (or forces them); prints how many are left
//   capri-helper media <action>         a media key; prints {"ok":…,"need":…}
//   capri-helper perms                  what macOS lets her do: {"screen":…,"accessibility":…}
//   capri-helper ask-accessibility      macOS's own prompt to allow her the media keys
//   capri-helper activate <pid>         that app back in front (after typing to her)

import AppKit
import ApplicationServices
import CoreAudio
import CoreGraphics
import DiskArbitration
import Foundation
import IOKit
import IOKit.usb

setvbuf(stdout, nil, _IOLBF, 0)

func json(_ s: String) -> String {
  var out = "\""
  for u in s.unicodeScalars {
    switch u {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
    }
  }
  return out + "\""
}

func emit(_ line: String) {
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

// ---------- the apps ----------

// The apps you use (the ones with a Dock icon), not the background helpers.
func runningApps() -> String {
  let mine = getpid()
  let rows = NSWorkspace.shared.runningApplications
    .filter { $0.activationPolicy == .regular && $0.processIdentifier != mine && !$0.isTerminated }
    .map { app in
      "{\"pid\":\(app.processIdentifier),\"name\":\(json(app.localizedName ?? app.executableURL?.lastPathComponent ?? "")),\"bundle\":\(json(app.bundleIdentifier ?? ""))}"
    }
  return "[" + rows.joined(separator: ",") + "]"
}

// Like Cmd+Q: the app can still ask you to save. `force`: ended outright.
func quit(_ pids: [pid_t], force: Bool) -> Int {
  for pid in pids {
    guard let app = NSRunningApplication(processIdentifier: pid) else { continue }
    if force { app.forceTerminate() } else { app.terminate() }
  }
  let wait = force ? 0.6 : 2.5
  let until = Date().addingTimeInterval(wait)
  var left = pids.filter { kill($0, 0) == 0 }
  while !left.isEmpty && Date() < until {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    left = left.filter { kill($0, 0) == 0 }
  }
  return left.count
}

// The apps in the usual folders, by the name Finder shows (in your language) and by their file name.
func installedApps() -> String {
  let fm = FileManager.default
  let home = fm.homeDirectoryForCurrentUser.path
  let roots = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", home + "/Applications"]
  var rows: [String] = []
  var seen = Set<String>()
  func add(_ path: String) {
    guard !seen.contains(path) else { return }
    seen.insert(path)
    let file = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
    var shown = fm.displayName(atPath: path)
    if shown.hasSuffix(".app") { shown = String(shown.dropLast(4)) }
    rows.append("{\"name\":\(json(shown)),\"file\":\(json(file)),\"path\":\(json(path))}")
  }
  for root in roots {
    guard let entries = try? fm.contentsOfDirectory(atPath: root) else { continue }
    for entry in entries where !entry.hasPrefix(".") {
      let path = root + "/" + entry
      if entry.hasSuffix(".app") { add(path); continue }
      // a folder of apps ("Adobe After Effects 2025", "Microsoft Office"): one level down
      var isDir: ObjCBool = false
      guard fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue,
            let inner = try? fm.contentsOfDirectory(atPath: path) else { continue }
      for sub in inner where sub.hasSuffix(".app") { add(path + "/" + sub) }
    }
  }
  return "[" + rows.joined(separator: ",") + "]"
}

// ---------- media keys ----------

// The keys on a Mac keyboard's top row, posted like the real ones: whatever plays music reacts.
// macOS only lets an app post them once you've allowed it in Privacy & Security › Accessibility.
let MEDIA: [String: (Int32, Int)] = [
  "play": (16, 1), "pause": (16, 1), "next": (17, 1), "previous": (18, 1),
  "volup": (0, 3), "voldown": (1, 3), "mute": (7, 1),
]

func media(_ action: String) -> String {
  guard let (key, times) = MEDIA[action] else { return "{\"ok\":false}" }
  guard AXIsProcessTrusted() else { return "{\"ok\":false,\"need\":\"accessibility\"}" }
  for _ in 0..<times {
    for down in [true, false] {
      let flags = down ? 0xa00 : 0xb00
      let event = NSEvent.otherEvent(
        with: .systemDefined, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(flags)),
        timestamp: 0, windowNumber: 0, context: nil, subtype: 8, data1: Int(key) << 16 | flags, data2: -1)
      event?.cgEvent?.post(tap: .cghidEventTap)
      usleep(10000)
    }
  }
  return "{\"ok\":true}"
}

// ---------- watching ----------

// Other AIs: a key, what gives them away in the title of the window in front, and the name of
// their own app, if they have one.
let AIS: [(String, String, String)] = [
  ("chatgpt", "\\bChatGPT\\b", "chatgpt"),
  ("claude", "\\bClaude\\b", "claude"),
  ("codex", "\\bCodex\\b", "codex"),
  ("gemini", "\\bGemini\\b", ""),
  ("copilot", "\\bCopilot\\b", "copilot"),
  ("perplexity", "\\bPerplexity\\b", "perplexity"),
  ("deepseek", "\\bDeepSeek\\b", ""),
  ("grok", "\\bGrok\\b", ""),
  ("lechat", "\\bLe Chat\\b|\\bMistral AI\\b", ""),
  ("characterai", "character\\.ai", ""),
  ("metaai", "\\bMeta AI\\b", ""),
]

// Windows (on screen) that aren't windows you work in: the menu bar, the Dock, Stage Manager's strip…
let SYSTEM_OWNERS: Set<String> = [
  "Window Server", "Dock", "WindowManager", "Control Center", "Notification Center", "SystemUIServer",
  "Spotlight", "screencaptureui", "loginwindow", "Wallpaper",
]

// A game: its program sits in a launcher's library (Steam, Epic, GOG), or its app says it's one.
let GAME = try! NSRegularExpression(pattern: "/(?:steamapps/common|Epic Games|GOG Games)/([^/]+)/", options: [.caseInsensitive])
let NOT_GAME = try! NSRegularExpression(pattern: "launcher|client|redistributable|steamworks|studio", options: [.caseInsensitive])
let LAUNCHERS: Set<String> = ["com.valvesoftware.steam", "com.epicgames.EpicGamesLauncher", "com.gog.galaxy", "net.battle.app", "com.blizzard.bna"]

func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
  re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

final class Watch {
  let overlay: Int
  let parent: pid_t
  var last = ""
  var gameOf: pid_t = -1
  var game = ""
  var proc = ""
  var usb = "[]"
  var usbAt = Date.distantPast
  var plug = "null"
  var plugs = 0
  var spaces = 0 // how many times you went to another desktop (Space) or full-screen app
  var titles = false // macOS lets us read window titles (Screen Recording), looked at every few seconds
  var titlesAt = Date.distantPast
  let devices = Devices()

  init(overlay: Int, parent: pid_t) {
    self.overlay = overlay
    self.parent = parent
    devices.onChange = { [weak self] name, cls, plugged in
      guard let self = self else { return }
      self.plugs += 1
      self.plug = "{\"n\":\(self.plugs),\"in\":\(plugged),\"name\":\(json(name)),\"class\":\(json(cls))}"
    }
  }

  // The app in front, when it changes: its name, and the game it is, if one.
  func program(_ app: NSRunningApplication?) {
    let pid = app?.processIdentifier ?? -1
    if pid == gameOf { return }
    gameOf = pid
    game = ""
    proc = (app?.localizedName ?? "").lowercased()
    guard let app = app else { return }
    let path = app.bundleURL?.path ?? app.executableURL?.path ?? ""
    if let m = GAME.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)),
       let r = Range(m.range(at: 1), in: path) {
      let name = String(path[r])
      if !matches(NOT_GAME, name) { game = name }
      return
    }
    if LAUNCHERS.contains(app.bundleIdentifier ?? "") { return }
    if let url = app.bundleURL, let category = Bundle(url: url)?.infoDictionary?["LSApplicationCategoryType"] as? String,
       category.hasPrefix("public.app-category.") && category.hasSuffix("games") {
      let name = app.localizedName ?? ""
      if !name.isEmpty && !matches(NOT_GAME, name) { game = name }
    }
  }

  // USB sticks and SD cards plugged in, by the name of their folder in /Volumes, every couple of seconds.
  // Not the Mac's own disks, not disk images (.dmg), not network shares.
  let session = DASessionCreate(kCFAllocatorDefault)
  func sticks() -> String {
    if Date().timeIntervalSince(usbAt) < 2 { return usb }
    usbAt = Date()
    var names: [String] = []
    let urls = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: nil, options: [.skipHiddenVolumes]) ?? []
    for url in urls where url.path.hasPrefix("/Volumes/") {
      guard let session = session, let disk = DADiskCreateFromVolumePath(kCFAllocatorDefault, session, url as CFURL),
            let info = DADiskCopyDescription(disk) as? [String: Any] else { continue }
      let builtIn = info[kDADiskDescriptionDeviceInternalKey as String] as? Bool ?? true
      let network = info[kDADiskDescriptionVolumeNetworkKey as String] as? Bool ?? false
      let proto = info[kDADiskDescriptionDeviceProtocolKey as String] as? String ?? ""
      let model = info[kDADiskDescriptionDeviceModelKey as String] as? String ?? ""
      if builtIn || network || proto == "Virtual Interface" || model.contains("Disk Image") { continue }
      names.append(json(url.lastPathComponent))
    }
    usb = "[" + names.joined(separator: ",") + "]"
    return usb
  }

  // Which of them the window in front is, as a JSON list of keys.
  func ai(_ title: String) -> String {
    var keys: [String] = []
    for (key, pattern, app) in AIS {
      let byTitle = !title.isEmpty && title.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
      if byTitle || (!app.isEmpty && proc == app) { keys.append(json(key)) }
    }
    return "[" + keys.joined(separator: ",") + "]"
  }

  // The screens' usable areas (no menu bar, no Dock), in the windows' coordinates (y down from the
  // top of the main screen), to tell a window filling one ("maximized").
  func usable() -> [CGRect] {
    guard let main = NSScreen.screens.first else { return [] }
    let top = main.frame.maxY
    return NSScreen.screens.flatMap { s -> [CGRect] in
      let v = s.visibleFrame, f = s.frame
      return [CGRect(x: v.minX, y: top - v.maxY, width: v.width, height: v.height),
              CGRect(x: f.minX, y: top - f.maxY, width: f.width, height: f.height)]
    }
  }

  // The Dock's settings, read again every couple of seconds: at the bottom or on a side, hiding
  // itself or not, the size of its icons.
  var dockPrefs = (bottom: true, autohide: false, tile: 48.0)
  var dockAt = Date.distantPast
  func dockSettings() -> (bottom: Bool, autohide: Bool, tile: Double) {
    if Date().timeIntervalSince(dockAt) < 2 { return dockPrefs }
    dockAt = Date()
    let domain = "com.apple.dock" as CFString
    CFPreferencesAppSynchronize(domain)
    let get = { (key: String) in CFPreferencesCopyAppValue(key as CFString, domain) }
    dockPrefs = (
      bottom: (get("orientation") as? String ?? "bottom") == "bottom",
      autohide: (get("autohide") as? NSNumber)?.boolValue ?? false,
      tile: (get("tilesize") as? NSNumber)?.doubleValue ?? 48)
    return dockPrefs
  }

  // The Dock's bar on that screen (in the windows' coordinates), when it's at the bottom: the room it
  // keeps there when it stays, else its icons' size and the margin around them (20 points).
  func dockBar(_ screen: CGRect) -> String {
    let p = dockSettings()
    guard p.bottom, let main = NSScreen.screens.first else { return "null" }
    var h = p.tile + 20
    let here = NSScreen.screens.first { s in
      abs(s.frame.minX - screen.minX) < 1 && abs(main.frame.maxY - s.frame.maxY - screen.minY) < 1
    }
    if !p.autohide, let s = here, s.visibleFrame.minY - s.frame.minY > 0 { h = s.visibleFrame.minY - s.frame.minY }
    return "{\"x\":\(Int(screen.minX)),\"y\":\(Int(screen.maxY - h)),\"w\":\(Int(screen.width)),\"h\":\(Int(h))}"
  }

  func snapshot() -> String {
    if Date().timeIntervalSince(titlesAt) > 3 {
      titlesAt = Date()
      titles = CGPreflightScreenCaptureAccess()
    }
    let front = NSWorkspace.shared.frontmostApplication
    program(front)
    let frontPid = front?.processIdentifier ?? -1
    let areas = usable()
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var fg = 0
    var title = ""
    var wins: [String] = []
    var dock = "null"
    var here = false // her own window, on screen on this desktop
    // Mission Control (or the desktops' overview) open: the Dock puts up a window of its own one level
    // under its usual one. Its Dock showing there isn't the Dock coming up under your pointer.
    let overview = list.contains { ($0[kCGWindowOwnerName as String] as? String) == "Dock" && ($0[kCGWindowLayer as String] as? Int) == Int(CGWindowLevelForKey(.dockWindow)) - 2 }
    for w in list {
      let id = w[kCGWindowNumber as String] as? Int ?? 0
      if id == overlay { here = true }
      let layer = w[kCGWindowLayer as String] as? Int ?? 0
      let pid = w[kCGWindowOwnerPID as String] as? pid_t ?? 0
      let owner = w[kCGWindowOwnerName as String] as? String ?? ""
      let alpha = w[kCGWindowAlpha as String] as? Double ?? 1
      // the Dock, while it's on screen: its window covers the whole screen it's on
      if !overview && owner == "Dock" && layer == Int(CGWindowLevelForKey(.dockWindow)) && dock == "null",
         let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) {
        dock = dockBar(r)
      }
      guard id != overlay, layer >= 0, layer < 8, alpha > 0.05, !SYSTEM_OWNERS.contains(owner),
            let b = w[kCGWindowBounds as String] as? NSDictionary,
            let r = CGRect(dictionaryRepresentation: b) else { continue }
      // the window in front: the app in front's first real one (not a strip like Safari's toolbar in
      // full screen, a window of its own up there), else its first one at all; its title, else the
      // first title that app has on screen
      let small = r.width < 200 || r.height < 120
      if pid == frontPid && layer == 0 {
        let name = w[kCGWindowName as String] as? String ?? ""
        if fg <= 0 && !small { fg = id; if !name.isEmpty { title = name } }
        if fg == 0 { fg = -id } // a small one, kept only in case there's nothing better
        if title.isEmpty && !name.isEmpty { title = name }
      }
      if wins.count >= 40 || small { continue }
      let max = areas.contains { a in r.minX <= a.minX + 2 && r.minY <= a.minY + 2 && r.maxX >= a.maxX - 2 && r.maxY >= a.maxY - 2 }
      wins.append("{\"id\":\(id),\"x\":\(Int(r.minX)),\"y\":\(Int(r.minY)),\"w\":\(Int(r.width)),\"h\":\(Int(r.height)),\"max\":\(max)}")
    }
    if fg < 0 { fg = -fg } // only small windows: the first of them
    // an app in front with no window (Finder on the desktop, her own chat): not any of the windows
    if fg == 0 && frontPid > 0 { fg = -Int(frontPid) }
    return "{\"fg\":\(fg),\"pid\":\(frontPid),\"app\":\(json(front?.bundleIdentifier ?? "")),\"ai\":\(ai(title)),\"game\":\(game.isEmpty ? "null" : json(game)),\"usb\":\(sticks()),\"plug\":\(plug),\"dock\":\(dock),\"space\":\(spaces),\"overview\":\(overview),\"titles\":\(titles),\"here\":\(overlay == 0 || here),\"wins\":[\(wins.joined(separator: ","))]}"
  }

  func run() {
    // stop with Capri: when she closes our input, or if she's gone without a word
    Thread.detachNewThread {
      while FileHandle.standardInput.availableData.count > 0 {}
      exit(0)
    }
    devices.start()
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.spaces += 1
    }
    var tick = 0
    Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [self] _ in
      autoreleasepool {
        let snap = snapshot()
        if snap != last {
          emit(snap)
          last = snap
        }
      }
      tick += 1
      if parent > 0 && tick % 20 == 0 && kill(parent, 0) != 0 { exit(0) }
    }
    // a real app loop (no Dock icon, no menu): macOS only tells one of those about desktop switches
    NSApplication.shared.setActivationPolicy(.prohibited)
    NSApplication.shared.run()
  }
}

// ---------- devices ----------

// Things plugged in or out: USB devices, Bluetooth keyboards, mice and controllers, headsets (wired,
// USB or Bluetooth). What's there when she starts is only remembered. A phone shows up as several
// devices one after the other: what changed in a second and a bit is gathered, and the one that says
// the most about it is told ("iPhone" rather than "USB Composite Device").
final class Devices {
  var onChange: ((String, String, Bool) -> Void)?
  var port: IONotificationPortRef?
  var iterators: [io_iterator_t] = []
  var known: [UInt64: (String, String)] = [:] // registry id -> (name, class)
  var audio: [AudioObjectID: String] = [:]
  var added: [(String, String)] = []
  var removed: [(String, String)] = []
  var flush: Timer?
  var ready = false

  static let VAGUE = try! NSRegularExpression(pattern: "composite|hub|input device|hid|mass storage|generic|interface|host|bus|port|endpoint|service|receiver|controller interface", options: [.caseInsensitive])

  func start() {
    port = IONotificationPortCreate(kIOMainPortDefault)
    guard let port = port else { return }
    CFRunLoopAddSource(CFRunLoopGetMain(), IONotificationPortGetRunLoopSource(port).takeUnretainedValue(), .defaultMode)
    for cls in ["IOUSBHostDevice", "IOHIDDevice"] {
      watch(cls, kIOFirstMatchNotification, plugged: true)
      watch(cls, kIOTerminatedNotification, plugged: false)
    }
    audio = audioDevices()
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, DispatchQueue.main) { [weak self] _, _ in
      self?.audioChanged()
    }
    ready = true
  }

  func watch(_ cls: String, _ type: String, plugged: Bool) {
    var iterator: io_iterator_t = 0
    let me = Unmanaged.passUnretained(self).toOpaque()
    let callback: IOServiceMatchingCallback = plugged
      ? { ctx, it in Unmanaged<Devices>.fromOpaque(ctx!).takeUnretainedValue().arrived(it) }
      : { ctx, it in Unmanaged<Devices>.fromOpaque(ctx!).takeUnretainedValue().left(it) }
    IOServiceAddMatchingNotification(port, type, IOServiceMatching(cls), callback, me, &iterator)
    iterators.append(iterator)
    if plugged { arrived(iterator) } else { left(iterator) } // arms it (and what's already there)
  }

  func entryId(_ s: io_object_t) -> UInt64 {
    var id: UInt64 = 0
    IORegistryEntryGetRegistryEntryID(s, &id)
    return id
  }

  func prop(_ s: io_object_t, _ key: String) -> Any? {
    IORegistryEntryCreateCFProperty(s, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
  }

  // What it is, as a class pc.js knows (DiskDrive, AudioEndpoint, Camera, HIDClass…), or nil to leave it out.
  func describe(_ s: io_object_t) -> (String, String)? {
    if IOObjectConformsTo(s, "IOHIDDevice") != 0 {
      // a Bluetooth keyboard, mouse or controller (USB ones are told by their USB device)
      let transport = prop(s, "Transport") as? String ?? ""
      guard transport.hasPrefix("Bluetooth") else { return nil }
      let name = prop(s, "Product") as? String ?? ""
      return name.isEmpty ? nil : (name, "HIDClass")
    }
    if (prop(s, "bDeviceClass") as? Int) == 9 { return nil } // a hub
    if (prop(s, "Built-In") as? Bool) == true { return nil }
    var name = prop(s, "USB Product Name") as? String ?? prop(s, "kUSBProductString") as? String ?? ""
    if name.isEmpty {
      var buf = [CChar](repeating: 0, count: 128)
      IORegistryEntryGetName(s, &buf)
      name = String(cString: buf)
    }
    // its kind, from what its interfaces say they are
    var classes = Set<Int>()
    if let c = prop(s, "bDeviceClass") as? Int { classes.insert(c) }
    var it: io_iterator_t = 0
    if IORegistryEntryCreateIterator(s, kIOServicePlane, IOOptionBits(kIORegistryIterateRecursively), &it) == KERN_SUCCESS {
      var child = IOIteratorNext(it)
      while child != 0 {
        if let c = prop(child, "bInterfaceClass") as? Int { classes.insert(c) }
        IOObjectRelease(child)
        child = IOIteratorNext(it)
      }
      IOObjectRelease(it)
    }
    let cls = classes.contains(8) ? "DiskDrive" : classes.contains(1) ? "AudioEndpoint"
      : classes.contains(14) ? "Camera" : classes.contains(6) ? "Image" : classes.contains(3) ? "HIDClass" : "USB"
    return (name, cls)
  }

  func arrived(_ it: io_iterator_t) {
    var s = IOIteratorNext(it)
    while s != 0 {
      let id = entryId(s)
      if !ready {
        if let d = describe(s) { known[id] = d }
      } else {
        // its interfaces are still coming up: looked at once the dust settles
        IOObjectRetain(s)
        let service = s
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [self] in
          if let d = describe(service) {
            known[id] = d
            note(d, plugged: true)
          }
          IOObjectRelease(service)
        }
      }
      IOObjectRelease(s)
      s = IOIteratorNext(it)
    }
  }

  func left(_ it: io_iterator_t) {
    var s = IOIteratorNext(it)
    while s != 0 {
      if ready, let d = known.removeValue(forKey: entryId(s)) { note(d, plugged: false) }
      IOObjectRelease(s)
      s = IOIteratorNext(it)
    }
  }

  // Headsets, AirPods, a USB microphone: the sound devices that come and go (not the Mac's own,
  // nor the virtual ones apps add, like Zoom's or a screen recorder's).
  func audioDevices() -> [AudioObjectID: String] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [:] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [:] }
    var out: [AudioObjectID: String] = [:]
    let external: Set<UInt32> = [kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE, kAudioDeviceTransportTypeUSB]
    for id in ids {
      var transport: UInt32 = 0
      var tsize = UInt32(MemoryLayout<UInt32>.size)
      var taddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
      guard AudioObjectGetPropertyData(id, &taddr, 0, nil, &tsize, &transport) == noErr, external.contains(transport) else { continue }
      var name: Unmanaged<CFString>?
      var nsize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
      var naddr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
      guard AudioObjectGetPropertyData(id, &naddr, 0, nil, &nsize, &name) == noErr, let n = name?.takeRetainedValue() else { continue }
      out[id] = n as String
    }
    return out
  }

  func audioChanged() {
    let now = audioDevices()
    for (id, name) in now where audio[id] == nil { note((name, "AudioEndpoint"), plugged: true) }
    for (id, name) in audio where now[id] == nil { note((name, "AudioEndpoint"), plugged: false) }
    audio = now
  }

  func note(_ d: (String, String), plugged: Bool) {
    if plugged { added.append(d) } else { removed.append(d) }
    flush?.invalidate()
    flush = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { [weak self] _ in self?.settle() }
  }

  func settle() {
    let plugged = !added.isEmpty
    let best = Devices.best(plugged ? added : removed)
    added = []
    removed = []
    if let best = best { onChange?(best.0, best.1, plugged) }
  }

  static func best(_ list: [(String, String)]) -> (String, String)? {
    var best: (String, String)?
    var top = Int.min
    for d in list where !d.0.isEmpty {
      var score = d.1 == "AudioEndpoint" ? 5 : d.1 == "Camera" || d.1 == "Image" ? 4 : d.1 == "HIDClass" ? 3 : 1
      if matches(VAGUE, d.0) { score -= 4 }
      if score > top { top = score; best = d }
    }
    return best
  }
}

// ---------- main ----------

let args = Array(CommandLine.arguments.dropFirst())
switch args.first ?? "" {
case "watch":
  let overlay = args.count > 1 ? Int(args[1]) ?? 0 : 0
  let parent = args.count > 2 ? pid_t(args[2]) ?? 0 : 0
  _ = NSApplication.shared // NSWorkspace keeps the app in front up to date through the run loop
  Watch(overlay: overlay, parent: parent).run()
case "apps":
  emit(runningApps())
case "installed":
  emit(installedApps())
case "quit":
  let force = args.contains("--force")
  let pids = args.dropFirst().compactMap { pid_t($0) }
  emit(String(quit(pids, force: force)))
case "media":
  emit(media(args.count > 1 ? args[1] : ""))
case "activate":
  let pid = args.count > 1 ? pid_t(args[1]) ?? 0 : 0
  emit(String(NSRunningApplication(processIdentifier: pid)?.activate(options: []) ?? false))
case "perms":
  emit("{\"screen\":\(CGPreflightScreenCaptureAccess()),\"accessibility\":\(AXIsProcessTrusted())}")
case "ask-accessibility":
  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  emit(String(AXIsProcessTrustedWithOptions([key: true] as CFDictionary)))
default:
  FileHandle.standardError.write("usage: capri-helper watch|apps|installed|quit|media|perms|ask-accessibility\n".data(using: .utf8)!)
  exit(2)
}
