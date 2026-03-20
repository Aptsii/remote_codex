import XCTest
@testable import CodexMobile

final class CodexThreadDecodeTests: XCTestCase {
    func testDecodesNestedSubagentThreadSpawnMetadata() throws {
        let json = """
        {
          "id": "child-thread",
          "title": "Conversation",
          "source": {
            "subagent": {
              "thread_spawn": {
                "parent_thread_id": "parent-thread",
                "agent_nickname": "Pauli",
                "agent_role": "explorer"
              }
            }
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CodexThread.self, from: json)

        XCTAssertEqual(decoded.parentThreadId, "parent-thread")
        XCTAssertEqual(decoded.agentNickname, "Pauli")
        XCTAssertEqual(decoded.agentRole, "explorer")
        XCTAssertTrue(decoded.isSubagent)
    }

    func testPrefersFlatParentThreadIdentityWhenPresent() throws {
        let json = """
        {
          "id": "child-thread",
          "parent_thread_id": "flat-parent",
          "source": {
            "subagent": {
              "thread_spawn": {
                "parent_thread_id": "nested-parent",
                "agent_nickname": "Nested",
                "agent_role": "explorer"
              }
            }
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CodexThread.self, from: json)

        XCTAssertEqual(decoded.parentThreadId, "flat-parent")
        XCTAssertEqual(decoded.agentNickname, "Nested")
        XCTAssertEqual(decoded.agentRole, "explorer")
    }

    func testAcceptsStringSourceWithoutDroppingThread() throws {
        let json = """
        {
          "id": "regular-thread",
          "title": "Analyze project thoroughly",
          "source": "vscode"
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CodexThread.self, from: json)

        XCTAssertEqual(decoded.id, "regular-thread")
        XCTAssertEqual(decoded.title, "Analyze project thoroughly")
        XCTAssertNil(decoded.parentThreadId)
    }

    func testDecodesForkedFromParentThreadIdentity() throws {
        let json = """
        {
          "id": "child-thread",
          "forked_from_id": "parent-from-fork"
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(CodexThread.self, from: json)

        XCTAssertEqual(decoded.parentThreadId, "parent-from-fork")
        XCTAssertTrue(decoded.isSubagent)
    }
}
