import SwiftUI

/// The window of "Open Ferry": a table with one row for each box, and the items of the selected box.
/// It shows the same data as the menu and has the same actions.
struct BoxesWindow: View {
    static let id = "boxes"

    @ObservedObject var model: StatusModel
    @State private var selection: BoxSection.ID?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(model.summary)
                if let error = model.refreshError {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                }
            }
            .padding()
            VSplitView {
                table
                    .frame(minHeight: 120)
                detail
                    .frame(minHeight: 120)
            }
            Divider()
            HStack {
                if let message = model.syncMessage {
                    Text(message).lineLimit(2).textSelection(.enabled)
                }
                Spacer()
                Button(model.refreshing ? "Refreshing..." : "Refresh now") { model.refresh() }
                    .disabled(model.refreshing)
                Button(model.syncing ? "Syncing..." : "Sync now") { model.sync() }
                    .disabled(model.syncing)
            }
            .padding()
        }
        // The app is a menu bar app again when the window closes. "Open Ferry" gives it the Dock icon.
        .onDisappear { NSApplication.shared.setActivationPolicy(.accessory) }
    }

    /// One column for each value. To add a column, add a TableColumn here.
    private var table: some View {
        Table(model.sections, selection: $selection) {
            TableColumn("Box", value: \.name)
            TableColumn("State") { section in
                Text(section.box.map { $0.online ? "Online" : "Offline" } ?? "No status")
            }
            TableColumn("Free disk") { section in
                Text(section.box?.resources?.disk.map { Self.amount($0.freeKiB, of: $0.totalKiB) } ?? "")
            }
            TableColumn("Free memory") { section in
                Text(section.box?.resources?.memory.map { Self.amount($0.availableKiB, of: $0.totalKiB) } ?? "")
            }
            TableColumn("Needs action") { section in
                Text("\(section.actionCount)")
            }
            TableColumn("Ports") { section in
                Text(section.tunnel.map(Self.ports) ?? "")
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let section = model.sections.first(where: { $0.id == selection }) {
            BoxDetail(model: model, section: section)
        } else {
            Text("Select a box to see its items.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// `12.3 GiB (15%)`
    private static func amount(_ kib: Double, of totalKiB: Double) -> String {
        let gib = (kib / 1_048_576).formatted(.number.precision(.fractionLength(0...1)))
        guard totalKiB > 0 else { return "\(gib) GiB" }
        return "\(gib) GiB (\((kib / totalKiB).formatted(.percent.precision(.fractionLength(0...1)))))"
    }

    private static func ports(_ tunnel: TunnelFile) -> String {
        if !tunnel.connected { return "Tunnel disconnected" }
        if tunnel.forwards.isEmpty { return "None" }
        return tunnel.forwards.map { "localhost:\($0.localPort)" }.joined(separator: ", ")
    }
}

/// The items of one box, with the full message, the fix command, and Copy, and its ports.
private struct BoxDetail: View {
    @ObservedObject var model: StatusModel
    let section: BoxSection

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(section.name).font(.headline)
                if let box = section.box {
                    if let error = box.error {
                        Text(error).textSelection(.enabled)
                    }
                    if box.online && box.issues.isEmpty {
                        Text("Nothing needs action.").foregroundStyle(.secondary)
                    }
                    ForEach(Array(box.issues.enumerated()), id: \.offset) { _, issue in
                        item(issue)
                    }
                } else {
                    Text("The status file does not have this box.").foregroundStyle(.secondary)
                }
                if let tunnel = section.tunnel {
                    ports(tunnel)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
    }

    /// A click on the fix command runs it in Terminal, as in the menu.
    private func item(_ issue: BriefIssue) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(issue.title).bold()
            Text(issue.message).textSelection(.enabled)
            HStack {
                if let command = issue.command {
                    Button { model.openInTerminal(command) } label: {
                        Text(command).font(.body.monospaced())
                    }
                    .buttonStyle(.link)
                    .help("Run in Terminal")
                }
                Button("Copy") { model.copy(issue.command ?? issue.message) }
            }
        }
    }

    @ViewBuilder
    private func ports(_ tunnel: TunnelFile) -> some View {
        Text("Ports").font(.headline)
        if !tunnel.connected {
            Text("Tunnel disconnected")
        } else if tunnel.forwards.isEmpty {
            Text("No ports. Run ferry expose on the box.")
        } else {
            ForEach(Array(tunnel.forwards.enumerated()), id: \.offset) { _, forward in
                Button(forward.title) { model.openPort(forward.localPort) }
                    .buttonStyle(.link)
            }
        }
    }
}
