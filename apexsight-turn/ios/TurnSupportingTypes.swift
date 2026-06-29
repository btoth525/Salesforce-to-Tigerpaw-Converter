//
//  TurnSupportingTypes.swift
//  ApexSightNative
//
//  ⚠️ SCAFFOLD — the Master Handoff was not provided to the implementer, so these
//  three types are written from the references in the TURN handoff. ApexSight very
//  likely ALREADY defines `IceServerConfig`, `FrigateError`, and `KeychainStore`.
//
//  On your Mac:
//    • If a type below already exists in the app, DELETE that type from this file
//      (or delete this whole file) to avoid a "duplicate declaration" build error.
//    • Keep only what's missing. `TurnSettings`, `TurnSettingsView`, and the
//      watchdog reference these exact names/signatures.
//

import Foundation
import Security

#if canImport(WebRTC)
import WebRTC
#endif

// MARK: - IceServerConfig
//
// Decodes the RAW JSON ARRAY returned by the Worker / Flask route:
//   [ { "urls": [...], "username": "...", "credential": "..." }, ... ]

public struct IceServerConfig: Codable, Equatable {
    public let urls: [String]
    public let username: String?
    public let credential: String?

    public init(urls: [String], username: String? = nil, credential: String? = nil) {
        self.urls = urls
        self.username = username
        self.credential = credential
    }

    /// Tolerate `urls` arriving as either a string or an array of strings.
    private enum CodingKeys: String, CodingKey { case urls, username, credential }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let many = try? c.decode([String].self, forKey: .urls) {
            urls = many
        } else if let one = try? c.decode(String.self, forKey: .urls) {
            urls = [one]
        } else {
            urls = []
        }
        username = try c.decodeIfPresent(String.self, forKey: .username)
        credential = try c.decodeIfPresent(String.self, forKey: .credential)
    }
}

#if canImport(WebRTC)
public extension IceServerConfig {
    /// Bridge to the WebRTC framework's ICE server type.
    func rtcIceServer() -> RTCIceServer {
        if let username, let credential {
            return RTCIceServer(urlStrings: urls, username: username, credential: credential)
        }
        return RTCIceServer(urlStrings: urls)
    }
}
#endif

// MARK: - FrigateError
//
// The TURN handoff throws `FrigateError.message(...)`. If ApexSight already has
// this error type, delete this one.

public enum FrigateError: Error, LocalizedError {
    case message(String)

    public var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}

// MARK: - KeychainStore
//
// Minimal, safe Keychain wrapper. The TURN shared secret MUST live here, never in
// UserDefaults / App Group defaults / plist / source / logs.
//
// If ApexSight already has a `KeychainStore` with `readString(account:)`, delete
// this and keep the app's. If the app's KeychainStore lacks these methods, add
// equivalents there — do NOT fall back to UserDefaults for the secret.

public struct KeychainStore {
    /// Change to your app's bundle id / keychain service if you have a convention.
    public var service: String

    public init(service: String = "com.apexsight.native.turn") {
        self.service = service
    }

    /// Returns "" when the item is absent (callers treat empty as "missing").
    public func readString(account: String) throws -> String {
        var query: [String: Any] = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess else {
            throw FrigateError.message("Keychain read failed (\(status))")
        }
        guard let data = item as? Data, let string = String(data: data, encoding: .utf8) else {
            return ""
        }
        return string
    }

    public func writeString(_ value: String, account: String) throws {
        let data = Data(value.utf8)
        let query = baseQuery(account: account)

        // Upsert: try update first, fall back to add.
        let attributes: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

        if updateStatus == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw FrigateError.message("Keychain write failed (\(addStatus))")
            }
        } else if updateStatus != errSecSuccess {
            throw FrigateError.message("Keychain update failed (\(updateStatus))")
        }
    }

    public func deleteString(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw FrigateError.message("Keychain delete failed (\(status))")
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
