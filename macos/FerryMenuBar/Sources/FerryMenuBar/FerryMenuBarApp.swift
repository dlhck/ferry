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

        // One window: openWindow brings an open window to the front. It does not open at launch.
        Window("Ferry", id: BoxesWindow.id) {
            BoxesWindow(model: model)
        }
        .defaultSize(width: 820, height: 520)
        .defaultLaunchBehavior(.suppressed)
        .restorationBehavior(.disabled)
    }
}

struct MenuContent: View {
    @ObservedObject var model: StatusModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            summary
            if let error = model.refreshError {
                lines(error)
            }
            ForEach(Array(model.sections.enumerated()), id: \.offset) { _, section in
                Divider()
                if let box = section.box {
                    Text(cutMiddle("\(box.name)  \(box.online ? "ONLINE" : "OFFLINE")"))
                    if let error = box.error {
                        lines(error)
                    }
                    ForEach(Array(box.issues.enumerated()), id: \.offset) { _, issue in
                        item(issue)
                    }
                } else {
                    Text(cutMiddle(section.name))
                }
                if let tunnel = section.tunnel {
                    Text("Ports")
                    if !tunnel.connected {
                        Text("Tunnel disconnected")
                    } else if tunnel.forwards.isEmpty {
                        Text("No ports. Run ferry expose on the box.")
                    } else {
                        ForEach(Array(tunnel.forwards.enumerated()), id: \.offset) { _, forward in
                            Button(cutMiddle(forward.title)) { model.openPort(forward.localPort) }
                        }
                    }
                }
            }
            Divider()
            Button("Open Ferry") {
                // The app has a Dock icon only while the window is open. BoxesWindow removes it again.
                NSApplication.shared.setActivationPolicy(.regular)
                openWindow(id: BoxesWindow.id)
                NSApplication.shared.activate()
            }
            if let message = model.syncMessage {
                lines(message)
            }
            Button(model.syncing ? "Syncing..." : "Sync now") { model.sync() }
                .disabled(model.syncing)
            Button(model.refreshing ? "Refreshing..." : "Refresh now") { model.refresh() }
                .disabled(model.refreshing)
            Toggle("Notifications", isOn: $model.notificationsEnabled)
            if let error = model.notificationError {
                lines(error)
            }
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
    }

    private var summary: some View {
        lines(model.summary)
    }

    /// One issue: the short title, and a submenu with the full message, the fix command, and Copy.
    /// A click on the title runs the fix command in Terminal, when the issue has one.
    @ViewBuilder
    private func item(_ issue: BriefIssue) -> some View {
        Group {
            if let command = issue.command {
                Menu(issue.title) { details(issue) } primaryAction: { model.openInTerminal(command) }
            } else {
                Menu(issue.title) { details(issue) }
            }
        }
        .help(issue.message)
    }

    @ViewBuilder
    private func details(_ issue: BriefIssue) -> some View {
        lines(issue.message)
        Divider()
        if let command = issue.command {
            Button(cutMiddle(command)) { model.openInTerminal(command) }
        }
        Button("Copy") { model.copy(issue.command ?? issue.message) }
    }

    /// A text as menu lines of at most `titleLimit` characters, because a menu item does not wrap its title.
    private func lines(_ text: String) -> some View {
        ForEach(Array(wrapped(text).enumerated()), id: \.offset) { _, line in
            Text(line)
        }
    }
}
