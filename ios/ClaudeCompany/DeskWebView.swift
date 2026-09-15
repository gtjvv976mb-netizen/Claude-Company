import SwiftUI
import UIKit
import WebKit

/// What the screen needs to know about the web view, and the few things it may ask of it.
final class DeskState: ObservableObject {
    @Published var loading = false
    @Published var progress = 0.0
    @Published var failure: String?
    @Published var canGoBack = false

    var reload: (() -> Void)?
    var goBack: (() -> Void)?
    var open: ((URL) -> Void)?
}

/// The `WKWebView` on the desk's own pages. Own hosts stay inside; wallets and every
/// other site leave for iOS. Dialogs render natively. Pull down to reload.
struct DeskWebView: UIViewRepresentable {
    @ObservedObject var state: DeskState

    func makeCoordinator() -> Coordinator { Coordinator(state: state) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // The Guide's video plays inside its tab, not in a full-screen player it did not ask for.
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = Desk.userAgentSuffix
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        let ground = UIColor(red: Desk.ground.red, green: Desk.ground.green, blue: Desk.ground.blue, alpha: 1)
        web.backgroundColor = ground
        web.scrollView.backgroundColor = ground
        web.scrollView.contentInsetAdjustmentBehavior = .never

        let refresh = UIRefreshControl()
        refresh.tintColor = .white
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.pulled(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh

        context.coordinator.attach(web)
        web.load(URLRequest(url: Desk.home))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.detach()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let state: DeskState
        private weak var web: WKWebView?
        private var observers: [NSKeyValueObservation] = []

        init(state: DeskState) { self.state = state }

        func attach(_ web: WKWebView) {
            self.web = web
            observers = [
                web.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
                    DispatchQueue.main.async { self?.state.progress = view.estimatedProgress }
                },
                web.observe(\.canGoBack, options: [.new]) { [weak self] view, _ in
                    DispatchQueue.main.async { self?.state.canGoBack = view.canGoBack }
                },
            ]
            // `_ =`: these WebKit calls return a WKNavigation the shell never needs, and the
            // closures are typed () -> Void.
            state.reload = { [weak web] in _ = web?.reload() }
            state.goBack = { [weak web] in _ = web?.goBack() }
            state.open = { [weak web] url in _ = web?.load(URLRequest(url: url)) }
        }

        func detach() {
            observers = []
            web = nil
        }

        @objc func pulled(_ sender: UIRefreshControl) {
            _ = web?.reload()
        }

        // MARK: where a link goes

        /// Own pages stay in the shell. A wallet scheme (phantom://, solflare://, wc:), Phantom's
        /// https universal link, pump.fun, dexscreener — anything on another host in the main
        /// frame — is handed to iOS so the app that owns it opens rather than its website
        /// loading here. Sub-frames (the vendored WalletConnect graph, embedded players) and
        /// about:/blob:/data: documents load as they are.
        func webView(_ webView: WKWebView,
                     decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.allow); return }
            let scheme = url.scheme?.lowercased() ?? ""
            switch scheme {
            case "http", "https":
                let mainFrame = action.targetFrame?.isMainFrame ?? true
                if Desk.isOwn(url) || !mainFrame {
                    decisionHandler(.allow)
                } else {
                    leave(url)
                    decisionHandler(.cancel)
                }
            case "about", "blob", "data", "javascript":
                decisionHandler(.allow)
            default:
                leave(url)
                decisionHandler(.cancel)
            }
        }

        /// target="_blank": our own pages open in place, anything else leaves the shell.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if Desk.isOwn(url) { _ = webView.load(URLRequest(url: url)) } else { leave(url) }
            }
            return nil
        }

        private func leave(_ url: URL) {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }

        // MARK: loading

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            state.loading = true
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            state.loading = false
            state.failure = nil
            webView.scrollView.refreshControl?.endRefreshing()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            failed(webView, error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            failed(webView, error)
        }

        private func failed(_ webView: WKWebView, _ error: Error) {
            state.loading = false
            webView.scrollView.refreshControl?.endRefreshing()
            let nsError = error as NSError
            // A navigation we cancelled ourselves (a link handed to iOS) is not a failure.
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }   // frame load interrupted
            state.failure = nsError.localizedDescription
        }

        /// WebKit's content process died (memory pressure while the 3D floor was up). Reload
        /// rather than leave a white view.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            _ = webView.reload()
        }

        // MARK: dialogs — a bare WKWebView answers every confirm() with false

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(alert) ?? completionHandler()
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            present(alert) ?? completionHandler(false)
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler(alert.textFields?.first?.text ?? "")
            })
            present(alert) ?? completionHandler(nil)
        }

        /// Presents on the frontmost view controller. Returns nil when there is none to
        /// present on, so the caller can answer the page instead of leaving it hanging.
        @discardableResult
        private func present(_ alert: UIAlertController) -> Void? {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
                ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            guard var top = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
                ?? scene?.windows.first?.rootViewController else { return nil }
            while let next = top.presentedViewController { top = next }
            top.present(alert, animated: true)
            return ()
        }
    }
}
