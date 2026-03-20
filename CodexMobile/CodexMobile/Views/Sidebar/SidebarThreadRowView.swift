// FILE: SidebarThreadRowView.swift
// Purpose: Displays a single sidebar conversation row.
// Layer: View Component
// Exports: SidebarThreadRowView

import SwiftUI

struct SidebarThreadRowView: View {
    let thread: CodexThread
    let isSelected: Bool
    let runBadgeState: CodexThreadRunBadgeState?
    let diffTotals: TurnSessionDiffTotals?
    let timingLabel: String?
    let childSubagentCount: Int
    let isSubagentExpanded: Bool
    let onToggleSubagents: (() -> Void)?
    let onTap: () -> Void
    var onRename: ((String) -> Void)? = nil
    var onArchiveToggle: (() -> Void)? = nil
    var onDelete: (() -> Void)? = nil

    @State private var isShowingRenameAlert = false
    @State private var renameText = ""

    var body: some View {
        Group {
            if thread.isSubagent {
                subagentRow
            } else {
                parentRow
            }
        }
        .background {
            if isSelected {
                Color(.tertiarySystemFill).opacity(0.8)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .padding(.horizontal, 12)
        .contextMenu { contextMenuContent }
        .alert("Rename Conversation", isPresented: $isShowingRenameAlert) {
            TextField("Name", text: $renameText)
            Button("Rename") {
                let trimmed = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    onRename?(trimmed)
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    // MARK: - Parent row

    private var parentRow: some View {
        Button(action: {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            onTap()
        }) {
            HStack(alignment: .center, spacing: 8) {
                if let runBadgeState {
                    SidebarThreadRunBadgeView(state: runBadgeState)
                        .padding(.leading, 10)
                        .padding(.top, 4)
                } else {
                    Color.clear
                        .frame(width: 10, height: 10)
                        .padding(.leading, 10)
                        .padding(.top, 4)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(thread.displayTitle)
                        .font(AppFont.body())
                        .lineLimit(1)
                        .foregroundStyle(.primary)

                    if thread.syncState == .archivedLocal {
                        Text("Stored locally")
                            .font(AppFont.footnote())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) { parentTrailingMeta }
        .padding(.leading, 16)
        .padding(.trailing, 16)
        .padding(.vertical, 12)
    }

    private var parentTrailingMeta: some View {
        HStack(spacing: 6) {
            if thread.syncState == .archivedLocal {
                Text("Archived")
                    .font(AppFont.caption2())
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.orange.opacity(0.12), in: Capsule())
            }

            expansionToggleButton

            if let diffTotals, diffTotals.hasChanges {
                SidebarThreadDiffTotalsLabel(totals: diffTotals)
            }

            if let timingLabel {
                Text(timingLabel)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.trailing, 16)
    }

    // MARK: - Subagent row

    private var subagentRow: some View {
        Button(action: {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            onTap()
        }) {
            HStack(alignment: .center, spacing: 8) {
                Color.clear
                    .frame(width: 10, height: 10)
                    .padding(.leading, 10)

                SidebarSubagentNameLabel(thread: thread)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .trailing) { subagentTrailingMeta }
        .padding(.leading, 16)
        .padding(.trailing, 16)
        .padding(.vertical, 4)
    }

    private var subagentTrailingMeta: some View {
        HStack(spacing: 4) {
            expansionToggleButton

            if let diffTotals, diffTotals.hasChanges {
                SidebarThreadDiffTotalsLabel(totals: diffTotals)
            }

            if let timingLabel {
                Text(timingLabel)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.trailing, 16)
    }

    // MARK: - Shared

    @ViewBuilder
    private var expansionToggleButton: some View {
        if childSubagentCount > 0, let onToggleSubagents {
            Button(action: {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                onToggleSubagents()
            }) {
                Image(systemName: isSubagentExpanded ? "chevron.down" : "chevron.right")
                    .font(AppFont.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isSubagentExpanded ? "Collapse subagents" : "Expand subagents")
        }
    }

    @ViewBuilder
    private var contextMenuContent: some View {
        if onRename != nil {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                renameText = thread.displayTitle
                isShowingRenameAlert = true
            } label: {
                Label("Rename", systemImage: "pencil")
            }
        }

        if let onArchiveToggle {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                onArchiveToggle()
            } label: {
                Label(
                    thread.syncState == .archivedLocal ? "Unarchive" : "Archive",
                    systemImage: thread.syncState == .archivedLocal ? "tray.and.arrow.up" : "archivebox"
                )
            }
        }

        if let onDelete {
            Button(role: .destructive) {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                onDelete()
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }
}

private struct SidebarThreadDiffTotalsLabel: View {
    let totals: TurnSessionDiffTotals

    var body: some View {
        HStack(spacing: 3) {
            Text("+\(totals.additions)")
                .foregroundStyle(.green)
            Text("-\(totals.deletions)")
                .foregroundStyle(.red)
        }
        .font(AppFont.caption(weight: .semibold))
        .lineLimit(1)
    }
}

private struct SidebarSubagentNameLabel: View {
    let thread: CodexThread
    @Environment(CodexService.self) private var codex

    var body: some View {
        let _ = codex.subagentIdentityVersion
        let source = thread.preferredSubagentLabel
            ?? codex.resolvedSubagentDisplayLabel(threadId: thread.id, agentId: thread.agentId)
            ?? "Subagent"
        let parsed = SubagentLabelParser.parse(source)
        let nickname = parsed.nickname.isEmpty || parsed.nickname == "Conversation" ? "Subagent" : parsed.nickname
        SubagentLabelParser.styledText(nickname: nickname, roleSuffix: parsed.roleSuffix)
            .font(AppFont.caption(weight: .medium))
            .lineLimit(1)
            .truncationMode(.tail)
    }
}
