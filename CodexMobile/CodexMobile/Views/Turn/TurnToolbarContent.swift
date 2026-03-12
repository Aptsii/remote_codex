// FILE: TurnToolbarContent.swift
// Purpose: Encapsulates the TurnView navigation toolbar and thread-path sheet.
// Layer: View Component
// Exports: TurnToolbarContent, TurnThreadNavigationContext

import SwiftUI

struct TurnThreadNavigationContext {
    let folderName: String
    let subtitle: String
    let fullPath: String
}

struct TurnToolbarContent: ToolbarContent {
    let displayTitle: String
    let navigationContext: TurnThreadNavigationContext?
    let repoDiffTotals: GitDiffTotals?
    let isLoadingRepoDiff: Bool
    let showsGitActions: Bool
    let showsDesktopRefreshButton: Bool
    let isGitActionEnabled: Bool
    let isRunningGitAction: Bool
    let isRefreshingDesktopApp: Bool
    let showsDiscardRuntimeChangesAndSync: Bool
    let gitSyncState: String?
    let contextWindowUsage: ContextWindowUsage?
    var threadId: String = ""
    var isCompacting: Bool = false
    var onCompactContext: (() -> Void)?
    var onTapRepoDiff: (() -> Void)?
    var onRefreshDesktopApp: (() -> Void)?
    let onGitAction: (TurnGitActionKind) -> Void

    @Binding var isShowingPathSheet: Bool

    var body: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(alignment: .leading, spacing: 1) {
                Text(displayTitle)
                    .font(AppFont.headline())
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let context = navigationContext {
                    Button {
                        HapticFeedback.shared.triggerImpactFeedback(style: .light)
                        isShowingPathSheet = true
                    } label: {
                        Text(context.subtitle)
                            .font(AppFont.mono(.caption))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 10) {
                if let contextWindowUsage {
                    ContextWindowProgressRing(
                        usage: contextWindowUsage,
                        threadId: threadId,
                        isCompacting: isCompacting,
                        onCompact: onCompactContext
                    )
                }

                if let repoDiffTotals {
                    TurnToolbarDiffTotalsLabel(
                        totals: repoDiffTotals,
                        isLoading: isLoadingRepoDiff,
                        onTap: onTapRepoDiff
                    )
                }

                if showsDesktopRefreshButton, let onRefreshDesktopApp {
                    TurnDesktopRefreshToolbarButton(
                        isRefreshing: isRefreshingDesktopApp,
                        onTap: onRefreshDesktopApp
                    )
                }

                if showsGitActions {
                    TurnGitActionsToolbarButton(
                        isEnabled: isGitActionEnabled,
                        isRunningAction: isRunningGitAction,
                        showsDiscardRuntimeChangesAndSync: showsDiscardRuntimeChangesAndSync,
                        gitSyncState: gitSyncState,
                        onSelect: onGitAction
                    )
                }
            }
        }
    }
}

private struct TurnDesktopRefreshToolbarButton: View {
    let isRefreshing: Bool
    let onTap: () -> Void

    var body: some View {
        Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            onTap()
        } label: {
            Group {
                if isRefreshing {
                    ProgressView()
                        .controlSize(.mini)
                        .frame(width: 28, height: 28)
                } else {
                    Image(systemName: "arrow.clockwise.circle")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 28, height: 28)
                }
            }
            .contentShape(Circle())
            .adaptiveToolbarItem(in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(isRefreshing)
        .accessibilityLabel("Refresh Mac Codex app")
    }
}

private struct TurnToolbarDiffTotalsLabel: View {
    let totals: GitDiffTotals
    let isLoading: Bool
    let onTap: (() -> Void)?

    // Keeps small diff totals tappable without forcing large-count pills into a fixed width.
    private let minPillWidth: CGFloat = 64

    var body: some View {
        Group {
            if let onTap {
                Button {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    onTap()
                } label: {
                    labelContent
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
            } else {
                labelContent
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Repository diff total")
        .accessibilityValue(accessibilityValue)
    }

    private var labelContent: some View {
        HStack(spacing: 4) {
            if isLoading {
                ProgressView()
                    .controlSize(.mini)
            }
            Text("+\(totals.additions)")
                .foregroundStyle(Color.green)
            Text("-\(totals.deletions)")
                .foregroundStyle(Color.red)
            if totals.binaryFiles > 0 {
                Text("B\(totals.binaryFiles)")
                    .foregroundStyle(.secondary)
            }
        }
        .font(AppFont.mono(.caption))
        .padding(.horizontal, 4)
        .frame(minWidth: minPillWidth, minHeight: 28)
        .contentShape(Capsule())
        .fixedSize(horizontal: true, vertical: false)
        .opacity(isLoading ? 0.8 : 1)
        .adaptiveToolbarItem(in: Capsule())
    }

    private var accessibilityValue: String {
        if totals.binaryFiles > 0 {
            return "+\(totals.additions) -\(totals.deletions) binary \(totals.binaryFiles)"
        }
        return "+\(totals.additions) -\(totals.deletions)"
    }
}

struct TurnThreadPathSheet: View {
    let context: TurnThreadNavigationContext

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(context.fullPath)
                    .font(AppFont.mono(.callout))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle(context.folderName)
            .navigationBarTitleDisplayMode(.inline)
            .adaptiveNavigationBar()
        }
        .presentationDetents([.fraction(0.25), .medium])
    }
}
