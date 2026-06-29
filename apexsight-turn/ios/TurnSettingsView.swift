//
//  TurnSettingsView.swift
//  ApexSightNative
//
//  "Remote Relay (TURN)" settings section: credentials URL, shared secret, and a
//  Test Relay button that makes a real POST and reports the COUNT of usable ICE
//  servers (never the credentials).
//
//  Drop the `TurnSettingsSection` into your existing Settings `Form`/`List`, or
//  present `TurnSettingsScreen` standalone.
//

#if canImport(SwiftUI)
import SwiftUI

public struct TurnSettingsSection: View {
    @State private var urlString: String = TurnSettings.credentialsURLString ?? ""
    @State private var secret: String = ""
    @State private var secretIsSet: Bool = TurnSettings.hasSharedSecret()

    @State private var isTesting = false
    @State private var resultMessage: String?
    @State private var resultIsError = false

    public init() {}

    public var body: some View {
        Section {
            // URL — not secret, persisted to UserDefaults on change.
            TextField("https://apex-turn.example.workers.dev", text: $urlString)
                .textContentType(.URL)
                .keyboardType(.URL)
                .autocorrectionDisabled(true)
                .textInputAutocapitalization(.never)
                .onChange(of: urlString) { _, newValue in
                    TurnSettings.credentialsURLString = newValue
                }

            // Shared secret — stored in Keychain, never displayed back.
            SecureField(secretIsSet ? "•••••••• (saved — type to replace)" : "Shared secret",
                        text: $secret)
                .textContentType(.password)
                .autocorrectionDisabled(true)
                .textInputAutocapitalization(.never)

            HStack {
                Button("Save Secret") { saveSecret() }
                    .disabled(secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if secretIsSet {
                    Spacer()
                    Button("Clear", role: .destructive) { clearSecret() }
                }
            }

            Button {
                Task { await testRelay() }
            } label: {
                HStack {
                    Text("Test Relay")
                    if isTesting {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isTesting)

            if let resultMessage {
                Text(resultMessage)
                    .font(.footnote)
                    .foregroundStyle(resultIsError ? Color.red : Color.green)
            }
        } header: {
            Text("Remote Relay (TURN)")
        } footer: {
            Text("Lets two-way talk work away from home through the Cloudflare relay "
                 + "without opening any inbound ports. The URL must use https://. "
                 + "The shared secret is stored in the Keychain.")
        }
    }

    // MARK: Actions

    private func saveSecret() {
        do {
            try TurnSettings.saveSharedSecret(secret)
            secret = ""
            secretIsSet = TurnSettings.hasSharedSecret()
            show("Shared secret saved.", isError: false)
        } catch {
            show(message(for: error), isError: true)
        }
    }

    private func clearSecret() {
        do {
            try TurnSettings.saveSharedSecret("")   // empty -> delete
            secret = ""
            secretIsSet = false
            show("Shared secret cleared.", isError: false)
        } catch {
            show(message(for: error), isError: true)
        }
    }

    @MainActor
    private func testRelay() async {
        // Validate locally before hitting the network.
        do { _ = try TurnSettings.validatedURL() } catch {
            show(message(for: error), isError: true); return
        }
        guard TurnSettings.hasSharedSecret() || !secret.isEmpty else {
            show("Enter and save a shared secret first.", isError: true); return
        }
        // If the user typed a new secret but didn't tap Save, save it now so the
        // test reflects what they'll actually use.
        if !secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try? TurnSettings.saveSharedSecret(secret)
            secret = ""
            secretIsSet = TurnSettings.hasSharedSecret()
        }

        isTesting = true
        defer { isTesting = false }
        do {
            let servers = try await TurnSettings.loadServers()
            // Report COUNT only — never usernames/credentials.
            show("Relay OK — \(servers.count) usable ICE server\(servers.count == 1 ? "" : "s").",
                 isError: false)
        } catch {
            show(message(for: error), isError: true)
        }
    }

    private func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "Something went wrong."
    }

    private func show(_ text: String, isError: Bool) {
        resultMessage = text
        resultIsError = isError
    }
}

/// Standalone screen wrapper if you don't have an existing Settings form yet.
public struct TurnSettingsScreen: View {
    public init() {}
    public var body: some View {
        Form { TurnSettingsSection() }
            .navigationTitle("Remote Relay")
    }
}

#endif // canImport(SwiftUI)
