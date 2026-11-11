// swift-tools-version:6.2
import PackageDescription

let package = Package(
    name: "FerryMenuBar",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(name: "FerryMenuBar", path: "Sources/FerryMenuBar"),
    ],
    swiftLanguageModes: [.v5]
)
