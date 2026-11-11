import SwiftUI
import WebKit

@main
struct FurnitureARApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

/// Loads the assembly app from the server running on your Mac.
/// The Gemini key stays on the Mac; the phone only talks to the server.
struct ContentView: View {
    @AppStorage("serverURL") private var serverURL = "http://192.168.1.190:8765"
    @State private var showSettings = false
    @State private var loadError: String?
    @State private var reloadToken = 0

    var body: some View {
        ZStack {
            WebView(url: URL(string: serverURL), reloadToken: reloadToken, loadError: $loadError)
                .ignoresSafeArea()
                // Two-finger long press anywhere opens the server settings
                .simultaneousGesture(LongPressGesture(minimumDuration: 1.2).onEnded { _ in showSettings = true }, including: .all)

            if let loadError {
                VStack(spacing: 14) {
                    Image(systemName: "wifi.exclamationmark").font(.system(size: 40)).foregroundStyle(.orange)
                    Text("Can't reach the server").font(.headline)
                    Text(loadError).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Text("Make sure the Mac is running the server and this phone is on the same Wi-Fi.")
                        .font(.footnote).multilineTextAlignment(.center)
                    HStack {
                        Button("Retry") { self.loadError = nil; reloadToken += 1 }.buttonStyle(.borderedProminent)
                        Button("Server settings") { showSettings = true }.buttonStyle(.bordered)
                    }
                }
                .padding(24)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                .padding()
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(serverURL: $serverURL) {
                loadError = nil
                reloadToken += 1
            }
        }
    }
}

struct SettingsView: View {
    @Binding var serverURL: String
    var onSave: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.190:8765", text: $draft)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server address")
                } footer: {
                    Text("The address of the Mac running server/app.py. Open these settings any time with a long press.")
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        serverURL = draft.trimmingCharacters(in: .whitespaces)
                        onSave()
                        dismiss()
                    }
                }
            }
            .onAppear { draft = serverURL }
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL?
    let reloadToken: Int
    @Binding var loadError: String?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isInspectable = true
        if let url { web.load(URLRequest(url: url)) }
        context.coordinator.lastToken = reloadToken
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.lastToken != reloadToken, let url {
            context.coordinator.lastToken = reloadToken
            web.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: WebView
        var lastToken = 0
        init(_ parent: WebView) { self.parent = parent }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.loadError = error.localizedDescription
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.loadError = nil
        }
    }
}
