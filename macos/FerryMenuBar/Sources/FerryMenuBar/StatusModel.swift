import AppKit
import Foundation

/// The report of `ferry status --brief --json`, and the content of ~/.ferry/status.json.
struct BriefReport: Decodable, Sendable {
    let schemaVersion: Int
    let checkedAt: String
    let boxes: [BriefBox]
}

struct BriefBox: Decodable, Sendable {
    let name: String
    let host: String
    let online: Bool
    /// Why the box is offline.
    let error: String?
    let issues: [BriefIssue]
}

struct BriefIssue: Decodable, Sendable {
    let kind: String
    let name: String
    let state: String
    let message: String
    /// The Ferry command that fixes the issue, or nil when a person must act on the box.
    let command: String?
}

/// The content of ~/.ferry/tunnels/<box>.json, which `ferry tunnel --follow` writes.
struct TunnelFile: Decodable, Sendable {
    let schemaVersion: Int
    let box: String
    /// The pid of `ferry tunnel --follow`.
    let pid: Int
    /// False after the connection drops, until Ferry connects again.
    let connected: Bool
    let updatedAt: String
    let forwards: [TunnelForward]
}

struct TunnelForward: Decodable, Sendable {
    let name: String?
    let cwd: String?
    let boxPort: Int
    let localPort: Int

    /// `web · shop → localhost:3000`: the name, the last folder of cwd, and the local port.
    var title: String {
        let folder = cwd.map { URL(fileURLWithPath: $0).lastPathComponent }
        let parts = [name, folder].compactMap { $0 }.filter { !$0.isEmpty }
        let local = "localhost:\(localPort)"
        return parts.isEmpty ? local : "\(parts.joined(separator: " · ")) → \(local)"
    }
}

/// The menu part of one box: its report in status.json, its tunnel file, or both.
struct BoxSection: Sendable {
    let name: String
    let box: BriefBox?
    let tunnel: TunnelFile?
}

/// The envelope of `ferry --json`.
private struct Envelope<Value: Decodable>: Decodable {
    struct Failure: Decodable {
        let message: String
    }

    let ok: Bool
    let result: Value?
    let error: Failure?
}

/// The part of the `ferry sync --json` result that the menu shows. A failed box fails the whole sync.
private struct SyncReport: Decodable {
    struct Box: Decodable {
        let name: String
    }

    let boxes: [Box]
}

enum MenuState {
    /// ~/.ferry/status.json is missing or not valid.
    case missing
    /// The last check is older than 15 minutes, so ferry watch does not run.
    case stale(Date)
    case clear
    case issues(Int)
}

@MainActor
final class StatusModel: ObservableObject {
    @Published private(set) var report: BriefReport?
    /// The tunnel files whose `ferry tunnel --follow` runs, sorted by box.
    @Published private(set) var tunnels: [TunnelFile] = []
    @Published private(set) var checkedAt: Date?
    /// The error of the last "Refresh now".
    @Published private(set) var refreshError: String?
    @Published private(set) var refreshing = false
    /// The result of the last "Sync now".
    @Published private(set) var syncMessage: String?
    @Published private(set) var syncing = false
    /// Why Ferry cannot post notifications.
    @Published private(set) var notificationError: String?
    @Published var notificationsEnabled = UserDefaults.standard.object(forKey: StatusModel.notificationsKey) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(notificationsEnabled, forKey: Self.notificationsKey)
            notificationError = nil
            if notificationsEnabled { requestNotificationPermission() }
        }
    }

    private static let staleAfter: TimeInterval = 15 * 60
    private static let notificationsKey = "notifications"
    private let notifier = Notifier()
    /// The items of the last report that give a notification when they are new, or nil before the first report.
    private var alertItems: Set<String>?
    private let statusFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".ferry/status.json")
    private let tunnelsDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".ferry/tunnels")
    private var timer: Timer?

    init() {
        if notificationsEnabled { requestNotificationPermission() }
        reload()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
        // The app has one menu, so each menu that opens is the Ferry menu.
        NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
    }

    var state: MenuState {
        guard let report, let checkedAt else { return .missing }
        if Date().timeIntervalSince(checkedAt) > Self.staleAfter { return .stale(checkedAt) }
        // An offline box counts as one issue, and so does a disconnected tunnel. Ports do not count.
        // The tunnel of an offline box does not count, because the offline box is the cause.
        let offline = Set(report.boxes.filter { !$0.online }.map(\.name))
        let count = report.boxes.reduce(0) { $0 + ($1.online ? $1.issues.count : 1) }
            + tunnels.filter { !$0.connected && !offline.contains($0.box) }.count
        return count == 0 ? .clear : .issues(count)
    }

    /// The boxes of status.json in their order, then the boxes that have only a tunnel file.
    var sections: [BoxSection] {
        let boxes = report?.boxes ?? []
        let known = Set(boxes.map(\.name))
        let reported = boxes.map { box in
            BoxSection(name: box.name, box: box, tunnel: tunnels.first(where: { $0.box == box.name }))
        }
        let tunnelOnly = tunnels.filter { !known.contains($0.box) }.map { BoxSection(name: $0.box, box: nil, tunnel: $0) }
        return reported + tunnelOnly
    }

    /// Read ~/.ferry/status.json and ~/.ferry/tunnels/ again.
    func reload() {
        tunnels = readTunnels()
        guard let data = try? Data(contentsOf: statusFile),
              let report = try? JSONDecoder().decode(BriefReport.self, from: data)
        else {
            self.report = nil
            checkedAt = nil
            return
        }
        show(report)
    }

    /// Run `ferry status --brief --json` and show its result.
    func refresh() {
        guard !refreshing else { return }
        refreshing = true
        refreshError = nil
        tunnels = readTunnels()
        Task.detached {
            let outcome = Self.runFerry(["status", "--brief"], as: BriefReport.self)
            await MainActor.run {
                self.refreshing = false
                switch outcome {
                case let .success(report): self.show(report)
                case let .failure(error): self.refreshError = error.message
                }
            }
        }
    }

    /// Run `ferry sync`, show its result, then refresh the menu.
    func sync() {
        guard !syncing else { return }
        syncing = true
        syncMessage = nil
        Task.detached {
            let message: String
            switch Self.runFerry(["sync"], as: SyncReport.self) {
            case let .success(report):
                message = "Synced \(report.boxes.count) \(report.boxes.count == 1 ? "box" : "boxes")."
            case let .failure(error):
                message = error.message
            }
            await MainActor.run {
                self.syncing = false
                self.syncMessage = message
                // The menu is closed while the sync runs, so the notification tells the result.
                if self.notificationsEnabled { self.notifier.post(title: "Ferry sync", body: message) }
                self.refresh()
            }
        }
    }

    /// Run the command in Terminal. An executable .command file opens in Terminal without an Automation permission.
    func openInTerminal(_ command: String) {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("ferry-\(UUID().uuidString).command")
        let script = "#!/bin/sh\nrm -f \"$0\"\n\(command)\n"
        do {
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
            NSWorkspace.shared.open(file)
        } catch {
            refreshError = "Cannot open Terminal: \(error.localizedDescription)"
        }
    }

    /// Open a forwarded port in the default browser.
    func openPort(_ port: Int) {
        guard let url = URL(string: "http://localhost:\(port)") else { return }
        NSWorkspace.shared.open(url)
    }

    /// The valid tunnel files. A file whose pid does not run is stale: its `ferry tunnel --follow` stopped without removing it.
    private func readTunnels() -> [TunnelFile] {
        let files = (try? FileManager.default.contentsOfDirectory(at: tunnelsDirectory, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(TunnelFile.self, from: Data(contentsOf: $0)) }
            .filter { Self.isRunning($0.pid) }
            .sorted { $0.box < $1.box }
    }

    /// kill(pid, 0) sends no signal. ESRCH means no process has the pid. EPERM means that the process runs as another user.
    private static func isRunning(_ pid: Int) -> Bool {
        guard pid > 0, pid <= Int(Int32.max) else { return false }
        return kill(pid_t(pid), 0) == 0 || errno != ESRCH
    }

    private func show(_ report: BriefReport) {
        self.report = report
        checkedAt = Self.parseDate(report.checkedAt)
        notifyNewItems(report)
    }

    private func requestNotificationPermission() {
        notifier.requestPermission { [weak self] message in
            Task { @MainActor in self?.notificationError = message }
        }
    }

    /// Post one notification for each item that the previous report did not have: an offline box,
    /// a login or MCP login that needs a login, and a tool with drift. The first report sets the items without notifications.
    private func notifyNewItems(_ report: BriefReport) {
        var items: [(key: String, title: String, body: String)] = []
        var kept = Set<String>()
        for box in report.boxes {
            if box.online {
                items += box.issues.filter(Self.notifies).map { (key: "\(box.name)\t\($0.kind)\t\($0.name)", title: "Ferry: \(box.name)", body: $0.message) }
            } else {
                items.append((key: "\(box.name)\toffline", title: "Ferry: \(box.name) is offline", body: box.error ?? "Ferry cannot connect to the box."))
                // An offline box has no issues in the report. Keep its items, so that they give no new notification when the box is back.
                kept.formUnion(alertItems?.filter { $0.hasPrefix("\(box.name)\t") } ?? [])
            }
        }
        let previous = alertItems
        alertItems = kept.union(items.map(\.key))
        guard let previous, notificationsEnabled else { return }
        for item in items where !previous.contains(item.key) {
            notifier.post(title: item.title, body: item.body)
        }
    }

    private static func notifies(_ issue: BriefIssue) -> Bool {
        switch issue.kind {
        case "login": return issue.state != "unavailable"
        case "mcp-login": return true
        case "tool": return issue.state == "drift"
        default: return false
        }
    }

    private struct RunError: Error {
        let message: String
    }

    /// Run ferry with the arguments and --json, and decode the result of its envelope.
    private nonisolated static func runFerry<Value: Decodable>(_ arguments: [String], as _: Value.Type) -> Result<Value, RunError> {
        let process = Process()
        // The launchd agent sets FERRY_PATH to the path of ferry. A GUI app does not get the PATH of the shell.
        if let ferry = ProcessInfo.processInfo.environment["FERRY_PATH"], !ferry.isEmpty {
            process.executableURL = URL(fileURLWithPath: ferry)
            process.arguments = arguments + ["--json"]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["ferry"] + arguments + ["--json"]
        }
        let command = "ferry \(arguments.joined(separator: " "))"
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return .failure(RunError(message: "Cannot run ferry: \(error.localizedDescription)"))
        }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let envelope = try? JSONDecoder().decode(Envelope<Value>.self, from: data) else {
            return .failure(RunError(message: "\(command) --json printed no valid JSON."))
        }
        if envelope.ok, let result = envelope.result { return .success(result) }
        return .failure(RunError(message: envelope.error?.message ?? "\(command) failed."))
    }

    /// `checkedAt` is `Date.toISOString()` of JavaScript, with milliseconds.
    private static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
