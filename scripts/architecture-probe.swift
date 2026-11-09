import AppKit
import WebKit

@MainActor
final class ProbeHost: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let url: URL?
    let fixture: URL
    var window: NSWindow?
    var webView: WKWebView?

    init(url: URL?, fixture: URL) {
        self.url = url
        self.fixture = fixture
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1260, height: 790),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = url == nil ? "Ion architecture probe · AppKit" : "Ion architecture probe · WKWebView"
        window.center()
        self.window = window

        if let url {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let browser = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
            browser.navigationDelegate = self
            webView = browser
            window.contentView = browser
            browser.load(URLRequest(url: url))
        } else {
            do {
                let source = try String(contentsOf: fixture, encoding: .utf8)
                let scroll = NSTextView.scrollablePlainDocumentContentTextView()
                guard let text = scroll.documentView as? NSTextView else {
                    fatalError("AppKit did not supply an NSTextView")
                }
                text.isRichText = false
                text.isAutomaticQuoteSubstitutionEnabled = false
                text.isAutomaticDashSubstitutionEnabled = false
                text.isContinuousSpellCheckingEnabled = false
                text.allowsUndo = true
                text.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
                text.textContainerInset = NSSize(width: 14, height: 14)
                text.string = source
                window.contentView = scroll
                window.makeFirstResponder(text)
            } catch {
                fputs("Could not read the probe fixture\n", stderr)
                NSApplication.shared.terminate(nil)
                return
            }
        }

        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate()
        FileHandle.standardInput.readabilityHandler = { [weak self] input in
            let data = input.availableData
            let open = data.contains(111)
            let quit = data.isEmpty || data.contains(113)
            Task { @MainActor in
                if quit {
                    NSApplication.shared.terminate(nil)
                } else if open {
                    _ = try? await self?.webView?.evaluateJavaScript("window.architectureProbeOpen()")
                }
            }
        }

        if url == nil {
            DispatchQueue.main.async {
                window.displayIfNeeded()
                print("READY native")
                fflush(stdout)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let requested = action.request.url
        let allowed = requested?.scheme == "http" && requested?.host == "127.0.0.1" && requested?.port == url?.port
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fputs("WKWebView load failed: \(error.localizedDescription)\n", stderr)
        NSApplication.shared.terminate(nil)
    }
}

@main
struct ArchitectureProbe {
    @MainActor
    static func main() {
        let arguments = CommandLine.arguments
        guard arguments.count == 3 else { fatalError("Usage: architecture-probe <url|native> <fixture-path>") }
        let url = arguments[1] == "native" ? nil : URL(string: arguments[1])
        guard arguments[1] == "native" || (url?.scheme == "http" && url?.host == "127.0.0.1") else {
            fatalError("The probe requires a loopback URL")
        }
        let app = NSApplication.shared
        let delegate = ProbeHost(url: url, fixture: URL(fileURLWithPath: arguments[2]))
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        app.run()
    }
}
