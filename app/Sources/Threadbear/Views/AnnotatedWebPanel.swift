import SwiftUI
import WebKit

/// Annotation belongs to the page already visible in Threadbear.
struct AnnotatedWebPanel: View {
    let url: URL
    let threadID: String
    var scriptsFor: String?
    var leaving: ((URL) -> Void)?
    @Environment(AppModel.self) private var app
    @Environment(\.isDockGhost) private var isGhost
    @ObservedObject private var annotations = EmbeddedBrowserAnnotations.shared

    private var webView: WKWebView? {
        WebPanelPool.shared.loadedWebView(for: url, scriptsFor: scriptsFor)
    }

    private var active: Bool {
        annotations.threadID == threadID && webView != nil && annotations.activeWebView === webView
    }

    var body: some View {
        VStack(spacing: 0) {
            if app.experiments.contains("browserAnnotations"), !app.isRemote(threadID) {
                HStack(spacing: zoomed(8)) {
                    if active {
                        Button("Cancel annotation") { annotations.cancel() }
                            .tip("Close the annotation tools without changing your draft")
                    } else {
                        Button("Annotate", systemImage: "pencil.tip.crop.circle") {
                            guard let webView else { return }
                            annotations.start(webView: webView, sourceURL: url, thread: threadID, app: app)
                        }
                        .disabled(annotations.activeWebView != nil || isGhost)
                        .tip("Select elements or draw on this page, here in Threadbear")
                    }
                    Spacer(minLength: 0)
                }
                .controlSize(.small)
                .padding(.horizontal, zoomed(10))
                .padding(.vertical, zoomed(6))
                Divider()
            }
            WebPanel(url: url, scriptsFor: scriptsFor, leaving: leaving)
            if app.experiments.contains("browserAnnotations"), !app.isRemote(threadID) {
                let message = annotations.threadID == threadID && annotations.sourceURL == url ? annotations.message ?? "" : ""
                // A status change must not resize the captured viewport after Attach freezes its marks.
                Text(message)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: zoomed(40), alignment: .leading)
                    .padding(.horizontal, zoomed(8))
                    .tip(message)
            }
        }
        .onDisappear {
            guard !isGhost, annotations.threadID == threadID, let webView else { return }
            annotations.cancel(webView: webView)
        }
        .onChange(of: url) { old, _ in cancelPage(old, scripts: scriptsFor, thread: threadID) }
        .onChange(of: scriptsFor) { old, _ in cancelPage(url, scripts: old, thread: threadID) }
        .onChange(of: threadID) { old, _ in cancelPage(url, scripts: scriptsFor, thread: old) }
    }

    private func cancelPage(_ url: URL, scripts: String?, thread: String) {
        guard !isGhost, annotations.threadID == thread,
              let view = WebPanelPool.shared.loadedWebView(for: url, scriptsFor: scripts) else { return }
        annotations.cancel(webView: view)
    }
}
