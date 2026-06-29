//
//  TwoWayTalkController+RemoteTURN.swift
//  ApexSightNative
//
//  ⚠️ INTEGRATION SCAFFOLD. The real `TwoWayTalkController` was not available to
//  the implementer (only the TURN handoff was provided), so this is delivered as
//  an extension + step-by-step wiring notes rather than an in-place diff. Apply
//  the numbered steps to your actual controller on your Mac.
//
//  What this adds:
//    1. Fetching short-lived ICE servers from the minting endpoint (TURN) and
//       merging them into the peer connection config, so two-way talk can relay
//       remotely with no open inbound ports.
//    2. A 6-second ICE connection watchdog (TurnConnectionWatchdog) so a stalled
//       non-trickle ICE negotiation fails cleanly instead of hanging silently.
//
//  This file assumes the WebRTC framework. If your controller uses a different
//  WebRTC binding, keep the structure and adapt the type names.
//

import Foundation

#if canImport(WebRTC)
import WebRTC

// MARK: - Integration steps for TwoWayTalkController
//
// STEP 1 — Add a stored watchdog property to TwoWayTalkController:
//
//      private let iceWatchdog = TurnConnectionWatchdog(timeout: 6.0)
//
//      (If your controller is final/struct or you prefer composition, store it
//      wherever the peer connection lifecycle lives.)
//
// STEP 2 — When building the RTCConfiguration, append the minted TURN servers.
//          Replace your current `config.iceServers = [...]` line with a call that
//          awaits `remoteTurnIceServers()` below and appends the results, e.g.:
//
//      var servers = config.iceServers          // your existing LAN STUN, etc.
//      servers.append(contentsOf: await Self.remoteTurnIceServers())
//      config.iceServers = servers
//
//          `remoteTurnIceServers()` never throws — it returns [] if TURN isn't
//          configured or the mint fails, so LAN-only talk still works.
//
// STEP 3 — Arm the watchdog right after you call setLocalDescription / kick off
//          ICE for a NEW talk session (non-trickle: after the offer is created
//          and you begin gathering/connecting):
//
//      armIceWatchdog()
//
// STEP 4 — In your RTCPeerConnectionDelegate ICE-state callback, drive the
//          watchdog. Add these lines to
//          `peerConnection(_:didChange newState: RTCIceConnectionState)`:
//
//      switch newState {
//      case .connected, .completed:
//          iceWatchdog.succeed()
//      case .failed, .closed, .disconnected:
//          iceWatchdog.cancel()
//      default:
//          break
//      }
//
// STEP 5 — In your existing stopTalk()/teardown path, cancel the watchdog FIRST:
//
//      iceWatchdog.cancel()
//
//          (Your teardown must still release mic, audio session, and the peer
//          connection — see the acceptance criteria. The watchdog only governs
//          the connect deadline.)
//
// The helpers below implement the reusable pieces referenced above.

public extension TwoWayTalkController {

    /// Mint short-lived ICE servers for remote relay. Returns [] (never throws)
    /// when TURN is unconfigured or minting fails, so LAN talk is unaffected.
    static func remoteTurnIceServers() async -> [RTCIceServer] {
        guard TurnSettings.credentialsURLString?.isEmpty == false,
              TurnSettings.hasSharedSecret() else {
            return []   // TURN not configured — LAN-only.
        }
        do {
            let configs = try await TurnSettings.loadServers()
            return configs.map { $0.rtcIceServer() }
        } catch {
            // Surface count/category only — never the secret or credentials.
            #if DEBUG
            print("[TURN] mint failed, falling back to LAN ICE only")
            #endif
            return []
        }
    }
}

#endif // canImport(WebRTC)

// MARK: - Watchdog wiring (works with or without WebRTC available)
//
// These two methods are framework-agnostic so this file compiles even before you
// link WebRTC. They reference `iceWatchdog` — add that property per STEP 1.
//
// Uncomment after you add the `iceWatchdog` property to TwoWayTalkController:
//
//  public extension TwoWayTalkController {
//
//      /// Arm the 6s ICE deadline for a new talk session.
//      func armIceWatchdog() {
//          iceWatchdog.start { [weak self] in
//              guard let self else { return }
//              // Timed out: tear down and surface a clean error on the main thread.
//              DispatchQueue.main.async {
//                  self.handleIceTimeout()
//              }
//          }
//      }
//
//      /// Called by the watchdog when ICE didn't connect within 6 seconds.
//      func handleIceTimeout() {
//          // 1. Stop talk / release mic + audio session + peer connection.
//          self.stopTalk()                                  // <- your existing teardown
//          // 2. Tell the UI. Reuse your existing error surface; do NOT log secrets.
//          self.presentError(FrigateError.message(
//              "Couldn't connect for two-way talk (timed out after 6s). "
//              + "If you're off Wi-Fi, check the Remote Relay (TURN) settings."))
//      }
//  }
//
// `stopTalk()` and `presentError(_:)` are placeholders for ApexSight's existing
// teardown + error-presentation methods — wire them to the real ones.
