// FILE: SidebarThreadGrouping.swift
// Purpose: Produces sidebar thread groups by project path (`cwd`) and keeps archived chats separate.
// Layer: View Helper
// Exports: SidebarThreadGroupKind, SidebarThreadGroup, SidebarThreadGrouping

import Foundation

enum SidebarThreadGroupKind: Equatable {
    case project
    case archived
}

struct SidebarProjectChoice: Identifiable, Equatable {
    let id: String
    let label: String
    let projectPath: String
    let sortDate: Date
}

struct SidebarThreadGroup: Identifiable {
    let id: String
    let label: String
    let kind: SidebarThreadGroupKind
    let sortDate: Date
    let projectPath: String?
    let threads: [CodexThread]

    func contains(_ thread: CodexThread) -> Bool {
        threads.contains(where: { $0.id == thread.id })
    }
}

enum SidebarThreadGrouping {
    static func makeGroups(
        from threads: [CodexThread],
        now _: Date = Date(),
        calendar _: Calendar = .current
    ) -> [SidebarThreadGroup] {
        var archivedThreads: [CodexThread] = []

        for thread in threads {
            if thread.syncState == .archivedLocal {
                archivedThreads.append(thread)
            }
        }

        var groups = makeProjectGroups(from: threads)

        let sortedArchived = sortThreadsByRecentActivity(archivedThreads)
        if let firstArchived = sortedArchived.first {
            groups.append(
                SidebarThreadGroup(
                    id: "archived",
                    label: "Archived (\(sortedArchived.count))",
                    kind: .archived,
                    sortDate: firstArchived.updatedAt ?? firstArchived.createdAt ?? .distantPast,
                    projectPath: nil,
                    threads: sortedArchived
                )
            )
        }

        return groups
    }

    // Reuses the sidebar project grouping rules for places like the New Chat chooser.
    static func makeProjectChoices(from threads: [CodexThread]) -> [SidebarProjectChoice] {
        makeProjectGroups(from: threads).compactMap { group in
            guard let projectPath = group.projectPath else {
                return nil
            }

            return SidebarProjectChoice(
                id: group.id,
                label: group.label,
                projectPath: projectPath,
                sortDate: group.sortDate
            )
        }
    }

    // Resolves all live thread ids that belong to the tapped project, even if the visible group is filtered.
    static func liveThreadIDsForProjectGroup(_ group: SidebarThreadGroup, in threads: [CodexThread]) -> [String] {
        guard group.kind == .project else {
            return []
        }

        let threadsByID = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })

        return sortThreadsByRecentActivity(
            threads.filter { thread in
                thread.syncState != .archivedLocal
                    && projectGroupID(for: thread, threadsByID: threadsByID) == group.id
            }
        ).map(\.id)
    }

    private static func makeProjectGroup(
        projectKey: String,
        threads: [CodexThread],
        threadsByID: [String: CodexThread]
    ) -> SidebarThreadGroup {
        let sortedThreads = sortThreadsByRecentActivity(threads)
        let representativeThread = sortedThreads.first(where: {
            effectiveProjectPath(for: $0, threadsByID: threadsByID) != nil
        }) ?? sortedThreads.first
        let representativePath = representativeThread.flatMap {
            effectiveProjectPath(for: $0, threadsByID: threadsByID)
        }
        let sortDate = representativeThread?.updatedAt ?? representativeThread?.createdAt ?? .distantPast
        return SidebarThreadGroup(
            id: "project:\(projectKey)",
            label: representativePath.map(projectDisplayName(for:)) ?? representativeThread?.projectDisplayName ?? "No Project",
            kind: .project,
            sortDate: sortDate,
            projectPath: representativePath,
            threads: sortedThreads
        )
    }

    // Keeps project-derived UI consistent by centralizing the live-thread → project bucket mapping.
    private static func makeProjectGroups(from threads: [CodexThread]) -> [SidebarThreadGroup] {
        let threadsByID = Dictionary(uniqueKeysWithValues: threads.map { ($0.id, $0) })
        var liveThreadsByProject: [String: [CodexThread]] = [:]

        for thread in threads where thread.syncState != .archivedLocal {
            let projectKey = effectiveProjectKey(for: thread, threadsByID: threadsByID)
            liveThreadsByProject[projectKey, default: []].append(thread)
        }

        return liveThreadsByProject.map { projectKey, projectThreads in
            makeProjectGroup(projectKey: projectKey, threads: projectThreads, threadsByID: threadsByID)
        }
        .sorted { lhs, rhs in
            if lhs.sortDate != rhs.sortDate {
                return lhs.sortDate > rhs.sortDate
            }

            if lhs.label != rhs.label {
                return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
            }

            return lhs.id < rhs.id
        }
    }

    private static func sortThreadsByRecentActivity(_ threads: [CodexThread]) -> [CodexThread] {
        threads.sorted { lhs, rhs in
            let lhsDate = lhs.updatedAt ?? lhs.createdAt ?? .distantPast
            let rhsDate = rhs.updatedAt ?? rhs.createdAt ?? .distantPast
            if lhsDate != rhsDate {
                return lhsDate > rhsDate
            }
            return lhs.id < rhs.id
        }
    }

    private static func projectGroupID(for thread: CodexThread, threadsByID: [String: CodexThread]) -> String {
        "project:\(effectiveProjectKey(for: thread, threadsByID: threadsByID))"
    }

    private static func effectiveProjectKey(for thread: CodexThread, threadsByID: [String: CodexThread]) -> String {
        effectiveProjectPath(for: thread, threadsByID: threadsByID) ?? thread.projectKey
    }

    private static func effectiveProjectPath(
        for thread: CodexThread,
        threadsByID: [String: CodexThread],
        visited: Set<String> = []
    ) -> String? {
        if let normalizedProjectPath = thread.normalizedProjectPath {
            return normalizedProjectPath
        }

        guard let parentThreadID = thread.parentThreadId,
              !visited.contains(parentThreadID),
              let parentThread = threadsByID[parentThreadID] else {
            return nil
        }

        var nextVisited = visited
        nextVisited.insert(thread.id)
        return effectiveProjectPath(for: parentThread, threadsByID: threadsByID, visited: nextVisited)
    }

    private static func projectDisplayName(for projectPath: String) -> String {
        let lastComponent = (projectPath as NSString).lastPathComponent
        if !lastComponent.isEmpty, lastComponent != "/" {
            return lastComponent
        }

        return projectPath
    }
}
