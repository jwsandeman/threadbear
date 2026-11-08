import XCTest
import ThreadbearCore
@testable import Threadbear

@MainActor
final class OhMyPiTests: XCTestCase {
    private let model = ModelChoice(id: "openrouter/example/model", model: "openrouter/example/model", title: "Example via OpenRouter", effortLevels: [])

    func testPickerPreservesOmpModelsAndDoesNotInventClaudeFallbacks() {
        let account = Account(id: "omp-main", provider: "omp", title: "Oh My Pi", models: [model])
        XCTAssertEqual(ModelPicker.providers([account]).first?.title, "Oh My Pi")
        let rows = ModelPicker.rows(choices: [model], defaultId: nil, selected: nil, provider: "omp")
        XCTAssertEqual(rows.map(\.id), [model.id])
        XCTAssertTrue(rows.allSatisfy { !$0.isOlder })
        XCTAssertTrue(ModelPicker.rows(choices: [], defaultId: nil, selected: nil, provider: "omp").isEmpty)
        XCTAssertTrue(ModelPicker.effortLevels(for: model.id, in: [model], provider: "omp").isEmpty)
        XCTAssertTrue(ModelPicker.effortLevels(for: nil, in: [], provider: "omp").isEmpty)
    }

    func testOmpWithoutASavedPoolIsStillAvailableAndCanBePicked() {
        let app = AppModel()
        let previousModel = app.lastModels["omp"]
        defer { app.remember(model: previousModel, provider: "omp") }
        app.accounts = [Account(id: "claude-main", provider: "claude", title: "Claude"),
                        Account(id: "omp-main", provider: "omp", title: "Oh My Pi", models: [model])]
        app.pools = [Pool(id: "claude", title: "Claude", accountIds: ["claude-main"])]
        app.poolsSupported = true
        app.newThreadAccount = "claude-main"
        let settings = ThreadSettings(app: app, thread: nil)
        let column = settings.columns.first { $0.title == "Oh My Pi" }
        XCTAssertNotNil(column)
        guard let column else { return }
        let row = settings.sections(for: column.id).first?.rows.first
        XCTAssertEqual(row?.id, model.id)
        guard let row else { return }
        settings.pick(row, section: "omp", column: column.id)
        XCTAssertEqual(app.newThreadAccountId, "omp-main")
        XCTAssertEqual(app.newThreadModel, model.id)
    }

    func testOmpDraftUsesAskWhenPreviousDraftWasPlan() {
        let app = AppModel()
        app.accounts = [Account(id: "omp-main", provider: "omp", title: "Oh My Pi", models: [model])]
        app.newThreadAccount = "omp-main"
        app.newThreadPermission = .plan
        let settings = ThreadSettings(app: app, thread: nil)
        XCTAssertEqual(settings.permissionMode, .ask)
        XCTAssertFalse(settings.permissionMenu().items.contains { $0.title == "Plan first" })
        XCTAssertEqual(app.newThreadRequest(text: "Hello", images: []).permissionMode, .ask)
    }

    func testOmpSignInUsesItsOwnExecutableAndConfiguration() {
        let script = SignIn.script(Account(id: "omp-main", provider: "omp", title: "Oh My Pi", configDir: "/tmp/omp agent"), cliPath: "/opt/bin/omp")
        XCTAssertTrue(script.contains("\nenv -u OMP_PROFILE -u PI_PROFILE PI_CODING_AGENT_DIR='/tmp/omp agent' '/opt/bin/omp' login\n"), script)
        XCTAssertFalse(script.contains("CLAUDE_CONFIG_DIR"))
        XCTAssertTrue(script.contains("Signing in to Oh My Pi"))
        XCTAssertTrue(AppModel.memoryProviders.contains("omp"))
    }
}
