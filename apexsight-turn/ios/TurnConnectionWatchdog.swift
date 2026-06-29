//
//  TurnConnectionWatchdog.swift
//  ApexSightNative
//
//  6-second ICE connection watchdog for two-way talk.
//
//  ApexSight uses NON-TRICKLE ICE. When relaying through TURN, a bad/empty
//  candidate set (or a stripped-but-still-unreachable server) can leave the peer
//  connection hanging in `.checking` forever with no audio and no error. This
//  watchdog gives the connection a hard deadline: if ICE has not reached a
//  connected state within `timeout` seconds, it fires `onTimeout` exactly once so
//  the controller can tear everything down and show a clean error instead of a
//  silent dead session.
//
//  Fully self-contained and unit-testable: no WebRTC dependency here.
//

import Foundation

public final class TurnConnectionWatchdog {

    /// Deadline for reaching a connected ICE state. Spec: 6 seconds.
    public let timeout: TimeInterval

    private let queue: DispatchQueue
    private var workItem: DispatchWorkItem?
    private var fired = false
    private let lock = NSLock()

    public init(timeout: TimeInterval = 6.0,
                queue: DispatchQueue = .main) {
        self.timeout = timeout
        self.queue = queue
    }

    /// Arm the watchdog. `onTimeout` runs on `queue` if `cancel()`/`succeed()`
    /// is not called first. Calling `start` again re-arms (cancels any prior arm).
    public func start(onTimeout: @escaping () -> Void) {
        lock.lock()
        cancelLocked()
        fired = false
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock()
            if self.fired { self.lock.unlock(); return }
            self.fired = true
            self.workItem = nil
            self.lock.unlock()
            onTimeout()
        }
        workItem = item
        lock.unlock()
        queue.asyncAfter(deadline: .now() + timeout, execute: item)
    }

    /// Call when ICE reaches `.connected`/`.completed`. Prevents the timeout.
    public func succeed() { cancel() }

    /// Cancel without firing (e.g. user stopped talk, or teardown started).
    public func cancel() {
        lock.lock()
        cancelLocked()
        lock.unlock()
    }

    /// True once the timeout has fired (and thus teardown should be in progress).
    public var hasFired: Bool {
        lock.lock(); defer { lock.unlock() }
        return fired
    }

    private func cancelLocked() {
        workItem?.cancel()
        workItem = nil
    }
}
