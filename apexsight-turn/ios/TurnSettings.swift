//
//  TurnSettings.swift
//  ApexSightNative
//
//  App-side TURN configuration + credential fetch for no-open-ports remote
//  two-way talk.
//
//  Storage split (do not change):
//    • turnCredentialsURL  -> UserDefaults  (not secret)
//    • turnSharedSecret    -> Keychain ONLY (never UserDefaults / plist / logs)
//
//  The fetch uses POST (both Worker and Flask routes are POST-only) and decodes
//  the RAW JSON array `[IceServerConfig]`.
//

import Foundation

public enum TurnSettings {

    // MARK: Keys

    /// UserDefaults key for the (non-secret) minting endpoint URL.
    public static let urlDefaultsKey = "turnCredentialsURL"
    /// Keychain account name for the shared secret.
    public static let secretKeychainAccount = "turnSharedSecret"

    // MARK: URL (UserDefaults)

    public static var credentialsURLString: String? {
        get { UserDefaults.standard.string(forKey: urlDefaultsKey) }
        set {
            let trimmed = newValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let trimmed, !trimmed.isEmpty {
                UserDefaults.standard.set(trimmed, forKey: urlDefaultsKey)
            } else {
                UserDefaults.standard.removeObject(forKey: urlDefaultsKey)
            }
        }
    }

    /// Parsed, validated HTTPS URL. Throws a user-friendly error otherwise.
    public static func validatedURL() throws -> URL {
        guard let raw = credentialsURLString, !raw.isEmpty else {
            throw FrigateError.message("Set a TURN Credentials URL in Settings first.")
        }
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else {
            throw FrigateError.message("TURN Credentials URL is not a valid URL.")
        }
        guard scheme == "https" else {
            throw FrigateError.message("TURN Credentials URL must use https://.")
        }
        return url
    }

    // MARK: Shared secret (Keychain)

    private static let keychain = KeychainStore()

    public static func saveSharedSecret(_ secret: String) throws {
        let trimmed = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            try keychain.deleteString(account: secretKeychainAccount)
        } else {
            try keychain.writeString(trimmed, account: secretKeychainAccount)
        }
    }

    public static func hasSharedSecret() -> Bool {
        ((try? keychain.readString(account: secretKeychainAccount)) ?? "").isEmpty == false
    }

    // MARK: Fetch

    /// Reads URL from settings + secret from Keychain, then mints ICE servers.
    public static func loadServers() async throws -> [IceServerConfig] {
        try await fetch(validatedURL())
    }

    /// POSTs to the minting endpoint and returns usable ICE servers.
    ///
    /// SECURITY: never logs the Authorization header, the TURN username, or the
    /// TURN credential.
    private static func fetch(_ url: URL) async throws -> [IceServerConfig] {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.timeoutInterval = 10

        let secret = try keychain.readString(account: secretKeychainAccount)
        guard !secret.isEmpty else {
            throw FrigateError.message("TURN shared secret missing. Add it in Settings.")
        }
        req.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw FrigateError.message("Couldn't reach the TURN relay. Check the URL and your connection.")
        }

        guard let http = response as? HTTPURLResponse else {
            throw FrigateError.message("TURN mint failed: no HTTP response.")
        }
        switch http.statusCode {
        case 200...299:
            break
        case 401:
            throw FrigateError.message("TURN relay rejected the shared secret (401). Check Settings.")
        case 405:
            throw FrigateError.message("TURN relay rejected the request method (405). Endpoint must be POST.")
        default:
            throw FrigateError.message("TURN mint failed (HTTP \(http.statusCode)).")
        }

        let servers: [IceServerConfig]
        do {
            servers = try JSONDecoder().decode([IceServerConfig].self, from: data)
        } catch {
            throw FrigateError.message("TURN relay returned an unexpected response.")
        }
        guard !servers.isEmpty else {
            throw FrigateError.message("TURN mint returned no ICE servers.")
        }
        return servers
    }
}
