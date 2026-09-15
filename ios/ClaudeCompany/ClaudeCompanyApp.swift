import SwiftUI

/// The desk on a phone. One screen, the live site, and the few things a web view
/// cannot get from Safari: wallet handoff, deep links, dialogs, an offline card.
@main
struct ClaudeCompanyApp: App {
    var body: some Scene {
        WindowGroup {
            DeskView()
        }
    }
}
