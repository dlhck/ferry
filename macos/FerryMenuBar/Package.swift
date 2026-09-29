// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FerryMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "FerryMenuBar", path: "Sources/FerryMenuBar"),
    ]
)
