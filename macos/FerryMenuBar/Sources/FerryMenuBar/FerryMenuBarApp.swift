import SwiftUI

@main
struct FerryMenuBarApp: App {
    @StateObject private var model = StatusModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            switch model.state {
            case .missing, .stale:
                Image(systemName: "questionmark.circle")
            case .clear:
                Image(systemName: "checkmark.circle")
            case let .issues(count):
                Image(systemName: "exclamationmark.triangle.fill")
                Text("\(count)")
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
            if let report = model.report {
                ForEach(Array(report.boxes.enumerated()), id: \.offset) { _, box in
                    Divider()
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
                }
            }
            Divider()
            Button(model.refreshing ? "Refreshing..." : "Refresh now") { model.refresh() }
                .disabled(model.refreshing)
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
