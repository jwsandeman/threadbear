import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

@MainActor
final class ExperimentSettingsTests: XCTestCase {
    override func setUp() { super.setUp(); _ = NSApplication.shared }

    private func settings(_ json: String) throws -> RunnerSettings {
        try JSONDecoder().decode(RunnerSettings.self, from: Data(json.utf8))
    }

    private func connected() async throws -> (AppModel, HoldingTransport) {
        let app = AppModel()
        app.notificationsEnabled = false
        let transport = HoldingTransport()
        let client = RPCClient(transport: transport)
        try await client.start()
        app.useClientForTesting(client)
        return (app, transport)
    }

    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<400 where !condition() { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(condition(), "The settings response did not arrive", file: file, line: line)
    }

    func testConfirmedSettingsReplaceEnabledExperimentsWithoutReconnect() throws {
        let app = AppModel()
        app.experiments = ["removed", "browserAnnotations"]
        app.receive(try settings(#"{"experiments":[{"id":"browserAnnotations","on":false},{"id":"projectDecisions","on":true}]}"#))
        XCTAssertEqual(app.experiments, ["projectDecisions"], "confirmed settings remove disabled and retired experiments")

        app.receive(try settings(#"{"experiments":[{"id":"browserAnnotations","on":true},{"id":"projectDecisions","on":false}]}"#))
        XCTAssertEqual(app.experiments, ["browserAnnotations"], "turning a switch back on needs no new hello")

        app.receive(try settings(#"{"experiments":[{"id":"browserAnnotations","on":false}]}"#))
        XCTAssertTrue(app.experiments.isEmpty, "turning every experiment off clears the feature gates")
    }

    func testOlderSettingsPreserveHelloButAnExplicitEmptyListClearsIt() throws {
        let app = AppModel()
        app.experiments = ["browserAnnotations"]
        app.receive(try settings(#"{"idleMinutes":10}"#))
        XCTAssertEqual(app.experiments, ["browserAnnotations"], "an older runner has no authoritative experiment list")

        app.receive(try settings(#"{"experiments":[]}"#))
        XCTAssertTrue(app.experiments.isEmpty, "an explicit empty list says the runner has no experiments left")
    }

    func testSettingsGetRefreshesTheHelloSnapshot() async throws {
        let (app, transport) = try await connected()
        defer { transport.drop() }
        app.experiments = ["retired"]
        app.loadSettings()
        try await until { transport.waiting("settings.get") }
        transport.answer("settings.get", ["settings": ["experiments": [["id": "browserAnnotations", "on": true]]]])
        try await until { app.runnerSettings != nil }
        XCTAssertEqual(app.experiments, ["browserAnnotations"])
    }

    func testSwitchChangesItsGateOnlyWhenTheUpdateSucceeds() async throws {
        let (app, transport) = try await connected()
        defer { transport.drop() }
        app.receive(try settings(#"{"experiments":[{"id":"browserAnnotations","on":false}]}"#))
        app.updateSettings(SettingsUpdate(experiments: ["browserAnnotations": true]))
        XCTAssertEqual(app.runnerSettings?.experiments.first?.on, true, "the switch responds immediately")
        XCTAssertTrue(app.experiments.isEmpty, "an unconfirmed switch does not start or cancel a feature")
        try await until { transport.waiting("settings.update") }
        // The response also carries a different client's change to another switch.
        transport.answer("settings.update", ["settings": ["experiments": [["id": "browserAnnotations", "on": true], ["id": "projectDecisions", "on": true]]]])
        try await until { app.runnerSettings?.experiments.count == 2 }
        XCTAssertEqual(app.experiments, ["browserAnnotations", "projectDecisions"])
    }

    func testRejectedOffLeavesTheFeatureEnabledAndRestoresTheSwitch() async throws {
        let (app, transport) = try await connected()
        defer { transport.drop() }
        app.experiments = ["browserAnnotations"]
        app.receive(try settings(#"{"experiments":[{"id":"browserAnnotations","on":true}]}"#))
        app.updateSettings(SettingsUpdate(experiments: ["browserAnnotations": false]))
        XCTAssertEqual(app.runnerSettings?.experiments.first?.on, false)
        XCTAssertEqual(app.experiments, ["browserAnnotations"], "pending off must not discard an active annotation")
        try await until { transport.waiting("settings.update") }
        transport.fail("settings.update", message: "Could not save settings")
        try await until { transport.waiting("settings.get") }
        XCTAssertEqual(app.experiments, ["browserAnnotations"])
        XCTAssertEqual(app.settingsError, "Could not save settings")
        transport.answer("settings.get", ["settings": ["experiments": [["id": "browserAnnotations", "on": true]]]])
        try await until { app.runnerSettings?.experiments.first?.on == true }
        XCTAssertEqual(app.experiments, ["browserAnnotations"])
    }
}
