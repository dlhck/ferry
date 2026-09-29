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

/// The envelope of `ferry --json`.
private struct Envelope: Decodable {
    struct Failure: Decodable {
        let message: String
    }

    let ok: Bool
    let result: BriefReport?
    let error: Failure?
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
    @Published private(set) var checkedAt: Date?
    /// The error of the last "Refresh now".
    @Published private(set) var refreshError: String?
    @Published private(set) var refreshing = false

    private static let staleAfter: TimeInterval = 15 * 60
    private let statusFile = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".ferry/status.json")
    private var timer: Timer?

    init() {
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
        // An offline box counts as one issue.
        let count = report.boxes.reduce(0) { $0 + ($1.online ? $1.issues.count : 1) }
        return count == 0 ? .clear : .issues(count)
    }

    /// Read ~/.ferry/status.json again.
    func reload() {
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
        Task.detached {
            let outcome = Self.runStatus()
            await MainActor.run {
                self.refreshing = false
                switch outcome {
                case let .success(report): self.show(report)
                case let .failure(error): self.refreshError = error.message
                }
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

    private func show(_ report: BriefReport) {
        self.report = report
        checkedAt = Self.parseDate(report.checkedAt)
    }

    private struct RefreshError: Error {
        let message: String
    }

    private nonisolated static func runStatus() -> Result<BriefReport, RefreshError> {
        let process = Process()
        // The launchd agent sets FERRY_PATH to the path of ferry.
        if let ferry = ProcessInfo.processInfo.environment["FERRY_PATH"], !ferry.isEmpty {
            process.executableURL = URL(fileURLWithPath: ferry)
            process.arguments = ["status", "--brief", "--json"]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["ferry", "status", "--brief", "--json"]
        }
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return .failure(RefreshError(message: "Cannot run ferry: \(error.localizedDescription)"))
        }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else {
            return .failure(RefreshError(message: "ferry status --brief --json printed no valid JSON."))
        }
        if envelope.ok, let result = envelope.result { return .success(result) }
        return .failure(RefreshError(message: envelope.error?.message ?? "ferry status --brief failed."))
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
