import Foundation
import UserNotifications

/// Posts macOS notifications. UNUserNotificationCenter needs an app bundle, so the notifier
/// posts nothing when the binary runs outside "Ferry Menu Bar.app", for example with swift run.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private let center: UNUserNotificationCenter? =
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()

    override init() {
        super.init()
        center?.delegate = self
    }

    /// Ask for the permission. macOS asks the operator only once. `denied` gets the reason when Ferry cannot post.
    func requestPermission(denied: @escaping @Sendable (String) -> Void) {
        guard let center else {
            denied("Notifications need the app bundle.")
            return
        }
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            guard !granted else { return }
            denied(error.map { "Notifications are off: \($0.localizedDescription)" }
                ?? "Notifications are off. Allow them for Ferry Menu Bar in System Settings > Notifications.")
        }
    }

    func post(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        center?.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil), withCompletionHandler: nil)
    }

    /// Show the banner also while the app is active, for example while its menu is open.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
