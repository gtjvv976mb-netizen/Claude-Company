import Foundation

/// Where the desk lives. The one place the shell knows a URL.
enum Desk {
    /// The tower: every tenant's first tap is "which floor is mine".
    static let home = URL(string: "https://solana.claudedotcompany.com/tower.html")!

    /// Hosts that stay inside the shell. Anything else — pump.fun, dexscreener, Phantom's
    /// universal link — leaves for Safari or the app that owns it.
    static let ownHosts: Set<String> = [
        "solana.claudedotcompany.com",
        "claudedotcompany.com",
        "www.claudedotcompany.com",
    ]

    /// Appended to Safari's user agent so the site can tell the shell apart if it ever needs to.
    static let userAgentSuffix = "ClaudeCompany-iOS/1.0"

    /// The tower's own night (tower.html --bar, its masthead; solana.html --bg). Painted
    /// behind the web view so a launch or a reload never flashes white.
    static let ground = (red: 0x08 / 255.0, green: 0x05 / 255.0, blue: 0x0f / 255.0)

    static func floor(_ n: Int) -> URL {
        URL(string: "https://solana.claudedotcompany.com/floor.html?floor=\(n)")!
    }

    static func isOwn(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return ownHosts.contains(host)
    }

    /// Turns a link the app was opened with into a page to show, or nil to ignore it.
    ///   claudeco://floor/12   → floor 12
    ///   claudeco://tower      → the tower
    ///   https://<own host>/…  → that page (universal links, if they are ever configured)
    static func route(_ url: URL) -> URL? {
        if url.scheme?.lowercased() == "claudeco" {
            let parts = ([url.host ?? ""] + url.pathComponents.filter { $0 != "/" }).filter { !$0.isEmpty }
            if parts.first == "floor", parts.count >= 2, let n = Int(parts[1]), (1...50).contains(n) {
                return floor(n)
            }
            return home
        }
        if ["http", "https"].contains(url.scheme?.lowercased() ?? ""), isOwn(url) {
            return url
        }
        return nil
    }
}
