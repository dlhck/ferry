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
                if let error = model.configLoadError {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                }
                if let config = model.config {
                    // A global setting. A change needs a sync of each box.
                    Toggle("Agent notifications", isOn: Binding(
                        get: { config.notifications.agents },
                        set: { model.changeConfig(configArguments(key: "notifications.agents", values: [String($0)], box: nil), box: nil) }
                    ))
                    .toggleStyle(.switch)
                    .disabled(model.configBusy)
                }
                if let error = model.configError, error.box == nil {
                    Text(error.message).foregroundStyle(.red).textSelection(.enabled)
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
        .onAppear { model.loadConfig() }
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
            TableColumn("MCP gateway") { section in
                Text(section.box?.mcpGateway?.title ?? "")
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
            // The id gives each box its own text field drafts.
            BoxDetail(model: model, section: section)
                .id(section.id)
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

/// The items of one box, with the full message, the fix command, and Copy, its MCP gateway, its ports, and its settings.
private struct BoxDetail: View {
    @ObservedObject var model: StatusModel
    let section: BoxSection
    @State private var memoryDraft = ""
    @State private var projectDraft = ""

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
                if let gateway = section.box?.mcpGateway {
                    self.gateway(gateway)
                }
                if let tunnel = section.tunnel {
                    ports(tunnel)
                }
                if let box = model.config?.boxes.first(where: { $0.name == section.name }) {
                    settings(box)
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
    private func gateway(_ gateway: GatewayStatus) -> some View {
        Text("MCP gateway").font(.headline)
        Text(gateway.title)
        if let reason = gateway.reason {
            Text(reason).textSelection(.enabled)
        }
        ForEach(Array(gateway.servers.enumerated()), id: \.offset) { _, server in
            Text("\(server.name): \(server.title)").textSelection(.enabled)
        }
    }

    /// The settings of the box in ~/.ferry/config.toml. Each change runs one `ferry config set|unset` command.
    @ViewBuilder
    private func settings(_ box: ConfigReport.Box) -> some View {
        Text("Settings").font(.headline)
        if model.syncNeeded.contains(box.name) {
            HStack {
                Text("Settings changed, sync to apply.")
                Button(model.syncing ? "Syncing..." : "Sync now") { model.sync(box: box.name) }
                    .disabled(model.syncing)
            }
        }
        if let error = model.configError, error.box == box.name {
            Text(error.message).foregroundStyle(.red).textSelection(.enabled)
        }
        Group {
            Toggle("MCP gateway", isOn: Binding(
                get: { box.mcpGateway },
                set: { change(configArguments(key: "mcp_gateway", values: [String($0)], box: box.name), box) }
            ))
            .toggleStyle(.switch)

            Text("Shared stdio servers").bold()
            if let warnings = model.config?.warnings, !warnings.isEmpty {
                Text(warnings.joined(separator: " ")).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if box.stdioServers.isEmpty {
                Text("Ferry carries no stdio MCP server for this box.").foregroundStyle(.secondary)
            }
            ForEach(box.stdioServers, id: \.self) { name in
                Toggle(name, isOn: Binding(
                    get: { box.mcpGatewayShared.contains(name) },
                    set: { on in
                        let shared = on ? box.mcpGatewayShared + [name] : box.mcpGatewayShared.filter { $0 != name }
                        change(listArguments(key: "mcp_gateway_shared", values: shared, box: box.name), box)
                    }
                ))
                .toggleStyle(.checkbox)
            }

            Text("Agent memory limit").bold()
            Text(box.agentMemoryMax.map { "Limit: \($0)" } ?? "No limit").foregroundStyle(.secondary)
            HStack {
                TextField("For example 6G or 50%", text: $memoryDraft)
                    .frame(maxWidth: 240)
                Button("Apply") {
                    change(configArguments(key: "agent_memory_max", values: [memoryDraft.trimmingCharacters(in: .whitespaces)], box: box.name), box)
                    memoryDraft = ""
                }
                .disabled(memoryDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Clear") { change(configArguments(key: "agent_memory_max", values: nil, box: box.name), box) }
                    .disabled(box.agentMemoryMax == nil)
            }

            Text("Projects").bold()
            ForEach(box.projects, id: \.self) { project in
                HStack {
                    Text(project).textSelection(.enabled)
                    Button("Remove") {
                        change(listArguments(key: "projects", values: box.projects.filter { $0 != project }, box: box.name), box)
                    }
                }
            }
            HStack {
                TextField("Project path, for example code/app", text: $projectDraft)
                    .frame(maxWidth: 240)
                Button("Add") {
                    change(listArguments(key: "projects", values: box.projects + [projectDraft.trimmingCharacters(in: .whitespaces)], box: box.name), box)
                    projectDraft = ""
                }
                .disabled(projectDraft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .disabled(model.configBusy)
    }

    private func change(_ arguments: [String], _ box: ConfigReport.Box) {
        model.changeConfig(arguments, box: box.name)
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
