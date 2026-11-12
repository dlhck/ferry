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
    /// The disk and memory of the box. Nil when the box is offline, the check has no resource read, or the file is of an older Ferry.
    let resources: BoxResources?
    /// The MCP gateway of the box. Nil when the status has no gateway data, for example for an offline box or a file of an older Ferry.
    let mcpGateway: GatewayStatus?
}

/// The MCP gateway of one box. The app shows `state` and the server `state` as free text, so a new value does not break the decode.
struct GatewayStatus: Decodable, Sendable {
    struct Server: Decodable, Sendable {
        let name: String
        let state: String
    }

    /// `running`, `stopped`, `unavailable`, or `off`.
    let state: String
    /// Why the gateway is stopped or unavailable.
    let reason: String?
    let servers: [Server]

    /// The table cell: `Running`, `Stopped`, `Unavailable`, `Off`, or an unknown state as it is.
    var title: String {
        switch state {
        case "running": return "Running"
        case "stopped": return "Stopped"
        case "unavailable": return "Unavailable"
        case "off": return "Off"
        default: return state
        }
    }
}

/// The result of `ferry config get --json`. The app shows these values and changes them only with `ferry config set|unset`.
struct ConfigReport: Decodable, Sendable {
    struct Notifications: Decodable, Sendable {
        let agents: Bool
    }

    struct Box: Decodable, Sendable {
        let name: String
        let mcpGateway: Bool
        let mcpGatewayShared: [String]
        let agentMemoryMax: String?
        let projects: [String]
        /// The carried stdio MCP servers that the box can share through the gateway.
        let stdioServers: [String]
    }

    let notifications: Notifications
    let boxes: [Box]
}

/// The part of the `ferry config set|unset --json` result that the app uses.
struct ConfigChange: Decodable, Sendable {
    /// Nil for a global key, such as `notifications.agents`.
    let box: String?
    let syncNeeded: Bool
}

/// The arguments of `ferry config set <key> <values...> --box <box>`, or of `ferry config unset <key> --box <box>` when `values` is nil.
/// runFerry adds `--json`. The arguments go to the process as an array, never through a shell.
func configArguments(key: String, values: [String]?, box: String?) -> [String] {
    let command = values.map { ["config", "set", key] + $0 } ?? ["config", "unset", key]
    return command + (box.map { ["--box", $0] } ?? [])
}

/// The arguments that write a list key. An empty list unsets the key.
func listArguments(key: String, values: [String], box: String) -> [String] {
    configArguments(key: key, values: values.isEmpty ? nil : values, box: box)
}

struct BoxResources: Decodable, Sendable {
    struct Disk: Decodable, Sendable {
        let totalKiB: Double
        let freeKiB: Double
    }

    struct Memory: Decodable, Sendable {
        let totalKiB: Double
        let availableKiB: Double
    }

    /// The file system of the box home.
    let disk: Disk?
    let memory: Memory?
}

struct BriefIssue: Decodable, Sendable {
    let kind: String
    let name: String
    let state: String
    /// A short title. Nil in a status file of a Ferry before the summary.
    let summary: String?
    let message: String
    /// The Ferry command that fixes the issue, or nil when a person must act on the box.
    let command: String?

    /// The menu item title: the summary, else the message without its middle.
    var title: String { cutMiddle(summary ?? message) }
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

/// The content of ~/.ferry/tunnels/<box>.events.json, which `ferry tunnel --follow` writes.
struct EventsFile: Decodable, Sendable {
    let schemaVersion: Int
    let box: String
    let updatedAt: String
    /// The newest events, oldest first.
    let events: [AgentEvent]
}

/// An event that `ferry notify` wrote on the box. It has no prompt text and no agent output.
struct AgentEvent: Decodable, Sendable {
    let id: String
    let harness: String
    /// `turn-ended` or `waiting-for-input`.
    let kind: String
    let project: String
    /// The time on the box.
    let at: String
    /// The time on this Mac when `ferry tunnel --follow` received the event.
    let receivedAt: String

    /// `claude ended its turn in shop.`: the harness, the kind, and the last folder of the project.
    var body: String {
        let folder = URL(fileURLWithPath: project).lastPathComponent
        let action = kind == "waiting-for-input" ? "waits for input" : "ended its turn"
        return "\(harness) \(action) in \(folder)."
    }
}

/// The menu part of one box: its report in status.json, its tunnel file, or both.
struct BoxSection: Sendable, Identifiable {
    let name: String
    let box: BriefBox?
    let tunnel: TunnelFile?

    var id: String { name }

    /// An offline box counts as one item, and so does a disconnected tunnel. Ports do not count.
    /// The tunnel of an offline box does not count, because the offline box is the cause.
    var actionCount: Int {
        let boxCount = box.map { $0.online ? $0.issues.count : 1 } ?? 0
        let tunnelCount = tunnel.map { !$0.connected && box?.online != false ? 1 : 0 } ?? 0
        return boxCount + tunnelCount
    }
}

/// The envelope of `ferry --json`.
private struct Envelope<Value: Decodable>: Decodable {
    struct Failure: Decodable {
        let code: String?
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
    /// The values of `ferry config get --json`. Nil before the first read and after a failed read.
    @Published private(set) var config: ConfigReport?
    /// Why the app cannot read the settings.
    @Published private(set) var configLoadError: String?
    /// The error of the last settings change, and its box. The box is nil for a global key.
    @Published private(set) var configError: (box: String?, message: String)?
    /// A settings command runs.
    @Published private(set) var configBusy = false
    /// The boxes whose settings changed after their last sync. The app keeps them only in memory.
    @Published private(set) var syncNeeded = Set<String>()
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
    /// The agent events that the app read, as `<box> TAB <id>`. Each event gives one notification.
    private var seenEvents = Set<String>()
    /// An event that Ferry received before the app started gives no notification.
    private let launchedAt = Date()
    private let statusFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".ferry/status.json")
    private let tunnelsDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".ferry/tunnels")
    private var timer: Timer?
    /// The watchers of ~/.ferry and ~/.ferry/tunnels, by path.
    private var watchers: [String: DispatchSourceFileSystemObject] = [:]

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
        guard report != nil, let checkedAt else { return .missing }
        if Date().timeIntervalSince(checkedAt) > Self.staleAfter { return .stale(checkedAt) }
        let count = sections.reduce(0) { $0 + $1.actionCount }
        return count == 0 ? .clear : .issues(count)
    }

    /// The first line of the menu and of the window.
    var summary: String {
        switch state {
        case .missing:
            return "No Ferry status. Run ferry watch install."
        case let .stale(date):
            return "ferry watch is not running. Last check \(Self.age(date))."
        case .clear:
            return "All clear. Checked \(Self.age(checkedAt ?? Date()))."
        case let .issues(count):
            return "\(count) \(count == 1 ? "item needs" : "items need") action. Checked \(Self.age(checkedAt ?? Date()))."
        }
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
        watch()
        tunnels = readTunnels()
        notifyAgentEvents()
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

    /// Run `ferry sync`, or `ferry sync --box <box>`, show its result, then refresh the menu.
    /// A sync that succeeds removes the "sync to apply" mark of the boxes that it synced.
    func sync(box: String? = nil) {
        guard !syncing else { return }
        syncing = true
        syncMessage = nil
        Task.detached {
            let message: String
            let synced: [String]
            switch Self.runFerry(["sync"] + (box.map { ["--box", $0] } ?? []), as: SyncReport.self) {
            case let .success(report):
                message = "Synced \(report.boxes.count) \(report.boxes.count == 1 ? "box" : "boxes")."
                synced = report.boxes.map(\.name)
            case let .failure(error):
                message = error.message
                synced = []
            }
            await MainActor.run {
                self.syncing = false
                self.syncNeeded.subtract(synced)
                self.syncMessage = message
                // The menu is closed while the sync runs, so the notification tells the result.
                if self.notificationsEnabled { self.notifier.post(title: "Ferry sync", body: message) }
                self.refresh()
            }
        }
    }

    /// Read the settings with `ferry config get --json`.
    func loadConfig() {
        Task.detached {
            let outcome = Self.runFerry(["config", "get"], as: ConfigReport.self)
            await MainActor.run {
                switch outcome {
                case let .success(config):
                    self.config = config
                    self.configLoadError = nil
                case let .failure(error):
                    self.config = nil
                    // A Ferry without `ferry config` fails with a usage error. `ferry config get` has no other usage error.
                    self.configLoadError = error.code == "usage" ? "This Ferry has no settings command. Run ferry self-update." : error.message
                }
            }
        }
    }

    /// Run one `ferry config set|unset` command, mark the boxes that need a sync, then read the settings again.
    /// `box` is the box of the change, or nil for a global key. The app never writes config.toml itself.
    func changeConfig(_ arguments: [String], box: String?) {
        guard !configBusy else { return }
        configBusy = true
        configError = nil
        Task.detached {
            let outcome = Self.runFerry(arguments, as: ConfigChange.self)
            await MainActor.run {
                self.configBusy = false
                switch outcome {
                case let .success(change):
                    // A global change, such as notifications.agents, needs a sync of each box.
                    if change.syncNeeded {
                        self.syncNeeded.formUnion(change.box.map { [$0] } ?? (self.config?.boxes.map(\.name) ?? []))
                    }
                case let .failure(error):
                    self.configError = (box: box, message: error.message)
                }
                self.loadConfig()
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

    /// Put the text on the clipboard.
    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
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

    /// Reload after a change in ~/.ferry or ~/.ferry/tunnels. Ferry replaces each file with a rename, which changes its directory.
    /// A directory that does not exist yet gets its watcher at a later reload. A removed or moved directory loses its watcher.
    private func watch() {
        for directory in [statusFile.deletingLastPathComponent().path, tunnelsDirectory.path] where watchers[directory] == nil {
            let descriptor = open(directory, O_EVTONLY)
            guard descriptor >= 0 else { continue }
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .delete, .rename], queue: .main)
            source.setEventHandler { [weak self] in
                let events = source.data
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if !events.isDisjoint(with: [.delete, .rename]) {
                        source.cancel()
                        self.watchers[directory] = nil
                    }
                    self.reload()
                }
            }
            source.setCancelHandler { close(descriptor) }
            source.resume()
            watchers[directory] = source
        }
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

    /// Post one notification for each agent event in ~/.ferry/tunnels/<box>.events.json that the app did not read before.
    /// With notifications off, the app marks the events as read, so they give no notification later.
    private func notifyAgentEvents() {
        let files = (try? FileManager.default.contentsOfDirectory(at: tunnelsDirectory, includingPropertiesForKeys: nil)) ?? []
        for url in files where url.lastPathComponent.hasSuffix(".events.json") {
            guard let data = try? Data(contentsOf: url),
                  let file = try? JSONDecoder().decode(EventsFile.self, from: data),
                  file.schemaVersion == 1
            else { continue }
            for event in file.events where seenEvents.insert("\(file.box)\t\(event.id)").inserted {
                guard notificationsEnabled, let received = Self.parseDate(event.receivedAt), received >= launchedAt else { continue }
                notifier.post(title: "Ferry: \(file.box)", body: event.body)
            }
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
        /// The error code of the envelope, or nil when ferry gave no envelope.
        var code: String? = nil
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
        // stderr goes to a file, so that a full stderr pipe cannot block ferry while the app reads stdout.
        let stderrFile = FileManager.default.temporaryDirectory.appendingPathComponent("ferry-\(UUID().uuidString).stderr")
        defer { try? FileManager.default.removeItem(at: stderrFile) }
        FileManager.default.createFile(atPath: stderrFile.path, contents: nil)
        let stderr = FileHandle(forWritingAtPath: stderrFile.path)
        process.standardError = stderr ?? FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            try? stderr?.close()
            return .failure(RunError(message: "Cannot run ferry: \(error.localizedDescription)"))
        }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try? stderr?.close()
        guard let envelope = try? JSONDecoder().decode(Envelope<Value>.self, from: data) else {
            // Without a valid envelope, the last line of stderr tells the cause.
            let lastLine = ((try? String(contentsOf: stderrFile, encoding: .utf8)) ?? "")
                .split(whereSeparator: \.isNewline).last.map(String.init)
            return .failure(RunError(message: lastLine ?? "\(command) --json printed no valid JSON."))
        }
        if envelope.ok, let result = envelope.result { return .success(result) }
        return .failure(RunError(code: envelope.error?.code, message: envelope.error?.message ?? "\(command) failed."))
    }

    private static func age(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
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
