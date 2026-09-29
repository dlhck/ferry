import SwiftUI

@main
struct FerryMenuBarApp: App {
    @StateObject private var model = StatusModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            // The menu bar shows the label as a monochrome template, so each state has its own symbol and text.
            switch model.state {
            case .missing, .stale:
                Image(systemName: "ferry")
                    .accessibilityLabel("Ferry: status unknown")
                Text("?")
                    .accessibilityHidden(true)
            case .clear:
                Image(systemName: "ferry")
                    .accessibilityLabel("Ferry: all clear")
            case let .issues(count):
                Image(systemName: "ferry.fill")
                    .accessibilityLabel("Ferry: \(count) \(count == 1 ? "item needs" : "items need") action")
                Text("\(count)")
                    .accessibilityHidden(true)
            }
        }
        .menuBarExtraStyle(.menu)
    }
}

struct MenuContent: View {
    @ObservedObject var model: StatusModel

    var body: some View {
        Group {
            summary
            if let error = model.refreshError {
                Text(error)
            }
            ForEach(Array(model.sections.enumerated()), id: \.offset) { _, section in
                Divider()
                if let box = section.box {
                    Text("\(box.name)  \(box.online ? "ONLINE" : "OFFLINE")")
                    if let error = box.error {
                        Text(error)
                    }
                    ForEach(Array(box.issues.enumerated()), id: \.offset) { _, issue in
                        if let command = issue.command {
                            Button(issue.message) { model.openInTerminal(command) }
                        } else {
                            Text(issue.message)
                        }
                    }
                } else {
                    Text(section.name)
                }
                if let tunnel = section.tunnel {
                    Text("Ports")
                    if !tunnel.connected {
                        Text("Tunnel disconnected")
                    } else if tunnel.forwards.isEmpty {
                        Text("No ports. Run ferry expose on the box.")
                    } else {
                        ForEach(Array(tunnel.forwards.enumerated()), id: \.offset) { _, forward in
                            Button(forward.title) { model.openPort(forward.localPort) }
                        }
                    }
                }
            }
            Divider()
            if let message = model.syncMessage {
                Text(message)
            }
            Button(model.syncing ? "Syncing..." : "Sync now") { model.sync() }
                .disabled(model.syncing)
            Button(model.refreshing ? "Refreshing..." : "Refresh now") { model.refresh() }
                .disabled(model.refreshing)
            Toggle("Notifications", isOn: $model.notificationsEnabled)
            if let error = model.notificationError {
                Text(error)
            }
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
    }

    @ViewBuilder
    private var summary: some View {
        switch model.state {
        case .missing:
            Text("No Ferry status. Run ferry watch install.")
        case let .stale(date):
            Text("ferry watch is not running. Last check \(age(date)).")
        case .clear:
            Text("All clear. Checked \(age(model.checkedAt ?? Date())).")
        case let .issues(count):
            Text("\(count) \(count == 1 ? "item needs" : "items need") action. Checked \(age(model.checkedAt ?? Date())).")
        }
    }

    private func age(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
