// RadarHUD.swift
// DSH 任务雷达 · 原生悬浮窗（HUD）
//
// 独立的 AppKit 进程：无 Dock 图标、无菜单栏图标、无窗口边框，
// 常驻在所有 Space / 所有 App 之上。
//
// 收起态是一个 56×56 的圆形徽标（运行中的顶层会话数 + 呼吸圆点）；
// 鼠标移入圆形徽标后展开为 320pt 宽的面板，列出正在运行的会话；
// 鼠标离开 250ms 后收回。只有双击才激活 DeepSeek Harness，单击不做任何事。
//
// 只使用系统框架：AppKit / Foundation。不请求辅助功能（AX）权限，不做屏幕录制。
//
// 构建：bash build.sh
// 运行：./RadarHUD --url auto --interval 2
//       ./RadarHUD --url http://127.0.0.1:64274/x-radar/radar
//       ./RadarHUD --mock /tmp/radar-mock.json
//       ./RadarHUD --mock /tmp/radar-mock.json --expand   # 强制展开，用于截图
//
// 退出：右键菜单「退出」，或 SIGTERM / SIGINT（会删除 pid 文件）。

import AppKit
import Foundation
import Darwin

// MARK: - 常量

private enum HUD {
    /// 收起态圆形的直径（要求 52–56pt，取上限更醒目）。
    static let circleSize: CGFloat = 56
    static let circleRadius: CGFloat = circleSize / 2

    /// 展开态面板宽度 / 圆角。
    static let panelWidth: CGFloat = 320
    static let panelCorner: CGFloat = 18

    /// 圆形徽标距离面板边缘的留白（也是面板距屏幕边缘的留白）。
    static let edgeMargin: CGFloat = 12

    /// 圆形徽标所占的带状区域：12 上留白 + 56 圆 + 12 下留白。
    static let bandHeight: CGFloat = edgeMargin + circleSize + edgeMargin
    static let contentPadding: CGFloat = 12
    static let headerHeight: CGFloat = 34
    static let rowHeight: CGFloat = 42
    static let overflowHeight: CGFloat = 24
    static let emptyRowHeight: CGFloat = 32
    static let maxRows = 6
    /// 事件流二级视图一屏显示的行数。
    static let eventVisibleRows = 12
    static let rawVisibleRows = 12

    static let dotSize: CGFloat = 8
    static let numberFontSize: CGFloat = 24
    static let idleAlpha: CGFloat = 0.72
    static let defaultInterval: TimeInterval = 2.0

    /// 鼠标离开后延迟收回：给「从圆移到面板」留出宽限。
    static let collapseDelay: TimeInterval = 0.25
    /// 待批准红色脉冲的一个完整周期（秒）。
    static let pulsePeriod: TimeInterval = 1.4
    static let animationDuration: TimeInterval = 0.18

    /// `.screenSaver` 高于普通窗口，也高于全屏 App 的窗口；配合
    /// `.canJoinAllSpaces + .fullScreenAuxiliary` 可以压住全屏应用。
    static let topLevel: NSWindow.Level = .screenSaver
    static let offLevel: NSWindow.Level = .normal
}

private enum Paths {
    /// `--state-dir <path>` 覆盖（多宿主隔离时指向 ~/.dsh/agent-bridge/hosts/<port>）。
    /// 缺省仍是 ~/.dsh/agent-bridge，保持老用法与老安装可用。
    static var stateDirOverride: URL?

    static var bridgeDir: URL {
        if let stateDirOverride { return stateDirOverride }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dsh", isDirectory: true)
            .appendingPathComponent("agent-bridge", isDirectory: true)
    }
    static var pid: URL { bridgeDir.appendingPathComponent("hud.pid") }
    static var window: URL { bridgeDir.appendingPathComponent("hud-window.json") }
    static var radarURL: URL { bridgeDir.appendingPathComponent("radar-url.json") }
}

private let ISOFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private func log(_ message: String) {
    let line = "[\(ISOFormatter.string(from: Date()))] \(message)\n"
    print(line, terminator: "")
    fflush(stdout)
    let path = "/tmp/dsh-task-radar/hud.log"
    try? FileManager.default.createDirectory(atPath: "/tmp/dsh-task-radar", withIntermediateDirectories: true)
    if let handle = FileHandle(forWritingAtPath: path) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? line.write(toFile: path, atomically: true, encoding: .utf8)
    }
}

/// 完成提醒横幅（应用内绘制，不依赖系统通知权限）。
private final class BannerView: NSView {
    private let title: String
    private let body: String
    /// 高度不够被折叠掉的条数：0 表示没有折叠，>0 时在正文尾部追加「另有 N 条」。
    private var foldedCount = 0
    /// 点横幅 = 确认这一条（标记已读并从队列里移除），2.21。
    var onClick: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }

    init(frame: NSRect, title: String, body: String) {
        self.title = title
        self.body = body
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { nil }

    /// 折叠提示：布局层发现「可用高度不足」时，把被折叠的条数写到卡上，
    /// 用户至少知道还有多少条；条数回到 0 时自动撤掉这行字。
    func setFoldedCount(_ count: Int) {
        guard foldedCount != count else { return }
        foldedCount = count
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: 1, dy: 1)
        let path = NSBezierPath(roundedRect: rect, xRadius: 14, yRadius: 14)
        NSColor(calibratedWhite: 0.10, alpha: 0.94).setFill()
        path.fill()
        NSColor(calibratedRed: 0.36, green: 0.82, blue: 0.52, alpha: 0.9).setStroke()
        path.lineWidth = 1.2
        path.stroke()

        let dot = NSBezierPath(ovalIn: NSRect(x: 14, y: bounds.height - 26, width: 8, height: 8))
        NSColor.systemGreen.setFill()
        dot.fill()

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12.5, weight: .semibold),
            .foregroundColor: NSColor.white,
        ]
        (title as NSString).draw(in: NSRect(x: 28, y: bounds.height - 32, width: bounds.width - 42, height: 18),
                                 withAttributes: titleAttrs)

        let bodyAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.74),
        ]
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        var attrs = bodyAttrs
        attrs[.paragraphStyle] = paragraph
        let shownBody = foldedCount > 0 ? "\(body) · 另有 \(foldedCount) 条" : body
        (shownBody as NSString).draw(in: NSRect(x: 14, y: 12, width: bounds.width - 28, height: 34),
                                    withAttributes: attrs)
    }
}

// MARK: - 数据模型（字段全部可选，缺失/类型漂移一律容错）

private struct RadarCounts: Decodable {
    var pending = 0
    var running = 0
    var approvals = 0
    /// 待回答的 agent 提问（requestUserInput / WorkBuddy 确认卡），单独计数，
    /// 否则它会被当成普通批准，用户看到「需批准」却不知道是在问问题。
    var questions = 0
    /// 失败的 run：以前完全不出现在胶囊里（R-13）。
    var failed = 0
    var doneUnread = 0
    var autoConfirmed = 0

    private enum CodingKeys: String, CodingKey {
        case pending, running, approvals, questions, failed, doneUnread, autoConfirmed
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pending = RadarCounts.int(c, .pending)
        running = RadarCounts.int(c, .running)
        approvals = RadarCounts.int(c, .approvals)
        questions = RadarCounts.int(c, .questions)
        failed = RadarCounts.int(c, .failed)
        doneUnread = RadarCounts.int(c, .doneUnread)
        autoConfirmed = RadarCounts.int(c, .autoConfirmed)
    }

    private static func int(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Int {
        if let v = try? c.decodeIfPresent(Int.self, forKey: key) { return max(0, v) }
        if let v = try? c.decodeIfPresent(Double.self, forKey: key) { return max(0, Int(v)) }
        if let v = try? c.decodeIfPresent(String.self, forKey: key), let n = Int(v) {
            return max(0, n)
        }
        return 0
    }
}

/// 雷达 feed 里的一条任务/会话。列表只展示 `kind=session && status=running`。
/// 提问的结构化选项（2.20）：面板要把每个选项画成一行，点选即回执。
private struct RadarOption: Decodable {
    var id: String?
    var label: String?
    var description: String?

    private enum CodingKeys: String, CodingKey { case id, label, description }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        label = try? c.decodeIfPresent(String.self, forKey: .label)
        description = try? c.decodeIfPresent(String.self, forKey: .description)
    }

    var display: String { label ?? id ?? "选项" }
}

private struct RadarQuestion: Decodable {
    var id: String?
    var question: String?
    var options: [RadarOption]?

    private enum CodingKeys: String, CodingKey { case id, question, options }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        question = try? c.decodeIfPresent(String.self, forKey: .question)
        options = try? c.decodeIfPresent([RadarOption].self, forKey: .options)
    }
}

private struct RadarItem: Decodable {
    var id: String?
    var kind: String?
    var agent: String?
    var title: String?
    var status: String?
    var finalAnswer: String?
    var seen: Bool?
    var updatedAt: Int64?
    var approvalId: String?
    /// 桥发的一次性审批凭据：HUD 内联批准时要回传，否则 403。
    var approvalToken: String?
    /// 桥重启后遗留在队列里的审批：没有活 waiter，点「回答/批准」不会再送达任何进程。
    var staleApproval: Bool?
    var runId: String?
    var childCount: Int?
    var team: Bool?
    var children: [RadarChild]?
    var verdict: String?
    var round: Int?
    var missing: [String]?
    var path: String?
    var formatStatus: String?
    /// 提问的结构化问题与选项（2.20）：行标题用问题原文，选项在面板里逐条可点。
    var questions: [RadarQuestion]?
    /// 详情页的阶段/起止时间（R-16：以前声明了却从不解码）。
    var stages: [RadarStage]?
    var startedAt: Double?
    var finishedAt: Double?

    private enum CodingKeys: String, CodingKey {
        case id, kind, agent, title, status, finalAnswer, seen, updatedAt, approvalId, childCount, team, children
        case verdict, round, missing, path, approvalToken, runId, formatStatus, stages, startedAt, finishedAt, stale, questions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        agent = try? c.decodeIfPresent(String.self, forKey: .agent)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        finalAnswer = try? c.decodeIfPresent(String.self, forKey: .finalAnswer)
        seen = try? c.decodeIfPresent(Bool.self, forKey: .seen)
        updatedAt = try? c.decodeIfPresent(Int64.self, forKey: .updatedAt)
        approvalId = try? c.decodeIfPresent(String.self, forKey: .approvalId)
        childCount = try? c.decodeIfPresent(Int.self, forKey: .childCount)
        team = try? c.decodeIfPresent(Bool.self, forKey: .team)
        children = try? c.decodeIfPresent([RadarChild].self, forKey: .children)
        verdict = try? c.decodeIfPresent(String.self, forKey: .verdict)
        round = try? c.decodeIfPresent(Int.self, forKey: .round)
        missing = try? c.decodeIfPresent([String].self, forKey: .missing)
        approvalToken = try? c.decodeIfPresent(String.self, forKey: .approvalToken)
        staleApproval = try? c.decodeIfPresent(Bool.self, forKey: .stale)
        runId = try? c.decodeIfPresent(String.self, forKey: .runId)
        formatStatus = try? c.decodeIfPresent(String.self, forKey: .formatStatus)
        questions = try? c.decodeIfPresent([RadarQuestion].self, forKey: .questions)
        stages = try? c.decodeIfPresent([RadarStage].self, forKey: .stages)
        // feed 里时间是毫秒；以前这些字段声明了却从不解码（R-16），详情页永远
        // 只说「刚刚」。这里统一转成秒。
        startedAt = RadarItem.seconds(c, .startedAt)
        finishedAt = RadarItem.seconds(c, .finishedAt)
    }

    private static func seconds(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Double? {
        if let ms = try? c.decodeIfPresent(Double.self, forKey: key), ms > 0 { return ms / 1000 }
        if let s = try? c.decodeIfPresent(String.self, forKey: key) {
            let f = ISO8601DateFormatter()
            if let date = f.date(from: s) { return date.timeIntervalSince1970 }
        }
        return nil
    }

    /// 等宿主批准的任务（排在列表最前，桥侧 5 分钟内不处理会自动拒绝）。
    var isApproval: Bool { kind == "approval" }

    /// agent 在向你提问（不是危险命令授权，而是需要你选/答）：提示文案和
    /// 计数都要与批准区分开（R-05）。
    var isQuestion: Bool { kind == "question" }

    /// 失败的外部 run：必须出现在面板里，否则用户永远不知道跑挂了（R-13）。
    var isFailedRun: Bool { kind == "run" && status == "failed" }

    /// 办公产物行（docx/xlsx/pptx/pdf），点一下在 Finder 里定位。
    var isArtifact: Bool { kind == "artifact" }

    var isRunningSession: Bool {
        kind == "session" && status == "running"
    }

    /// 已被 worker 交付、但还没通过 L1 判别（待验收 / 返工中 / 需你决定）。
    var isReviewRun: Bool {
        kind == "run" && ["verifying", "rework", "blocked", "unverified"].contains(status ?? "")
    }

    /// 正在跑的外部 agent 任务（Agent Bridge run）：可点开看实时事件流。
    var isRunningRun: Bool {
        kind == "run" && status == "running"
    }

    /// 已完成但还没看过的外部 agent 任务（Agent Bridge run）。
    /// 它们不是 DSH 会话，没有可跳转的页面，所以做成「可点击置为已读」的行。
    var isDoneUnreadRun: Bool {
        (kind == "run" || kind == "session") && status == "done" && !(seen ?? false)
    }
}

/// 单条 item 解析失败时跳过它，而不是让整个数组/整个 payload 解析失败。
private struct LenientItem: Decodable {
    let value: RadarItem?
    init(from decoder: Decoder) throws {
        value = try? RadarItem(from: decoder)
    }
}

private struct RadarPayload: Decodable {
    var ok: Bool?
    var generatedAt: String?
    var counts: RadarCounts?
    var items: [RadarItem] = []
    /// 未读完成的完整 id 清单（宿主按 id#run / id#finishedAt 去重后给出，不受 12 行截断影响）。
    var doneUnreadIds: [String] = []
    var total: Int?
    var dsh: DshInfo?

    struct DshInfo: Decodable {
        var port: Int?
        var url: String?
    }

    /// 页面侧 client 半边（prd 2.22）：active=false 表示桌面端没在轮询，
    /// 点会话行只能降级成「打开 App」。
    struct ClientHalf: Decodable {
        var active: Bool?
        var lastBeacon: String?
        var ageMs: Double?
        var hint: String?
    }

    var clientHalf: ClientHalf?

    private enum CodingKeys: String, CodingKey {
        case ok, generatedAt, counts, items, total, dsh, clientHalf, doneUnreadIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
        counts = try? c.decodeIfPresent(RadarCounts.self, forKey: .counts)
        if let wrapped = try? c.decodeIfPresent([LenientItem].self, forKey: .items) {
            items = wrapped.compactMap(\.value)
        }
        total = try? c.decodeIfPresent(Int.self, forKey: .total)
        dsh = try? c.decodeIfPresent(DshInfo.self, forKey: .dsh)
        clientHalf = try? c.decodeIfPresent(ClientHalf.self, forKey: .clientHalf)
        doneUnreadIds = (try? c.decodeIfPresent([String].self, forKey: .doneUnreadIds)) ?? []
    }
}

private struct RadarURLFile: Decodable {
    var url: String?
    var port: Int?
    var updatedAt: Int64?
}

private struct SavedOrigin: Codable {
    var x: Double
    var y: Double
    /// 2 = 坐标是收起态圆形的左下角；旧版本（无 version）是 300×92 面板的
    /// 左下角，语义不同，升级后第一次启动回退到默认右下角。
    var version: Int?
}

/// 渲染层需要的全部状态。
private struct RenderState {
    var pending = 0
    var running = 0
    var approvals = 0
    var questions = 0
    var failed = 0
    var doneUnread = 0
    var autoConfirmed = 0
    var offline = false
    var items: [RadarItem] = []
    /// 宿主给的完整未读完成 id 清单（与 items 的 12 行截断无关），通知/清理共用它。
    var doneUnreadIds: [String] = []

    /// 大数字口径 = 正在进行的顶层会话数（不含子智能体/子会话）。
    var taskCount: Int { running }

    /// 列表行数（会话 + 运行中/完成未看的外部任务）。
    private var rowCount: Int {
        items.filter {
            $0.isApproval || $0.isQuestion || $0.isRunningSession || $0.isRunningRun ||
                $0.isReviewRun || $0.isDoneUnreadRun || $0.isFailedRun || $0.isArtifact
        }.count
    }

    /// 等 L1 判别的外部任务（待验收 / 返工中 / 需用户决定）。
    var reviewRuns: [RadarItem] {
        items.filter(\.isReviewRun)
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }

    /// 待批准的任务，新的在前。
    var approvalItems: [RadarItem] {
        items.filter(\.isApproval)
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }

    /// 待回答的提问，新的在前。
    var questionItems: [RadarItem] {
        items.filter(\.isQuestion)
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }

    /// 失败的 run：新的在前（点开看错误）。
    var failedRuns: [RadarItem] {
        items.filter(\.isFailedRun)
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }

    var runningSessions: [RadarItem] {
        items.filter(\.isRunningSession)
    }

    /// 完成未看的桥接任务，新的在前。
    var doneRuns: [RadarItem] {
        items.filter(\.isDoneUnreadRun)
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }

    /// 正在运行的外部任务，新的在前。
    var runningRuns: [RadarItem] {
        items.filter(\.isRunningRun)
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }

    /// 面板列表：待批准 → 运行中的会话 → 运行中的外部任务 → 完成未看的任务。
    /// 最近生成的办公产物，新的在前（最多 3 条，避免挤掉任务）。
    var artifactItems: [RadarItem] {
        items.filter(\.isArtifact)
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            .prefix(3)
            .map { $0 }
    }

    var panelRows: [RadarItem] {
        // 提问排最前（用户在等人答），然后才是批准、运行、验收、完成、失败、产物。
        questionItems + approvalItems + runningSessions + runningRuns + reviewRuns +
            doneRuns + failedRuns + artifactItems
    }
    var panelRowCount: Int { rowCount }

    /// 空闲 = 没有在跑的、没有等批准的、没有待回答的，也没有「完成未看」
    /// （旧定义漏掉了 doneUnread，于是有未看结果时胶囊也是暗的，R-11）。
    var idle: Bool { running == 0 && approvals == 0 && questions == 0 && doneUnread == 0 }

    /// 活跃任务（等批准 > 运行中 > 完成未看）。
    var activeItems: [RadarItem] {
        let questions = items.filter { $0.isQuestion }
        let approvals = items.filter { $0.isApproval }
        let running = items.filter { $0.isRunningSession || $0.isRunningRun }
        return questions + approvals + running
    }

    /// 圆内小字：优先给「团队完成度 2/5」，否则给首个运行任务的短名。
    var orbLabel: String? {
        let teamKids = items.filter { $0.team == true }.flatMap { $0.children ?? [] }
        if !teamKids.isEmpty {
            let done = teamKids.filter { ($0.taskStatus ?? "").contains("已完成") }.count
            return "\(done)/\(teamKids.count)"
        }
        guard let first = activeItems.first else { return nil }
        var raw = first.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        for prefix in ["DSH ", "DSH·", "/agent-teams "] where raw.hasPrefix(prefix) {
            raw.removeFirst(prefix.count)
        }
        guard !raw.isEmpty else { return nil }
        let chars = Array(raw)
        if chars.count <= 5 { return raw }
        return String(chars.prefix(4)) + "…"
    }

    /// 团队任务的完成比例（无团队任务时为 nil）。
    var teamFraction: CGFloat? {
        let children = items.filter { $0.team == true }.flatMap { $0.children ?? [] }
        guard !children.isEmpty else { return nil }
        let done = children.filter { ($0.taskStatus ?? "").contains("已完成") }.count
        return CGFloat(done) / CGFloat(children.count)
    }

    /// 团队成员小点：一个点一个成员（最多 6 个）。
    var teamDots: [NSColor] {
        let children = items.filter { $0.team == true }.flatMap { $0.children ?? [] }
        return children.prefix(6).map { child in
            if child.isRunning { return NSColor.systemGreen }
            if (child.taskStatus ?? "").contains("已完成") { return NSColor(calibratedWhite: 0.66, alpha: 1) }
            return NSColor(calibratedWhite: 0.40, alpha: 1)
        }
    }

    /// 面板底部/顶部副行：需批准 > 完成未看，取前两个非零。
    var statLines: [(String, NSColor)] {
        var out: [(String, NSColor)] = []
        if questions > 0 { out.append(("等你回答 \(questions)", NSColor.systemYellow)) }
        if approvals > 0 { out.append(("需批准 \(approvals)", NSColor.systemRed)) }
        if failed > 0 { out.append(("失败 \(failed)", NSColor.systemRed)) }
        if doneUnread > 0 {
            out.append(("完成未看 \(doneUnread)", NSColor(calibratedWhite: 0.78, alpha: 0.75)))
        }
        // 用户 2026-11-16 要求：自动代确认要可回溯，胶囊里留一行计数。
        if autoConfirmed > 0 {
            out.append(("代你确认 \(autoConfirmed) 次", NSColor(calibratedWhite: 0.62, alpha: 0.72)))
        }
        return Array(out.prefix(3))
    }

    var signature: String {
        let sessions = runningSessions
            .map { "\($0.agent ?? "-")|\($0.title ?? "-")" }
            .joined(separator: ",")
        let done = doneRuns
            .map { "\($0.id ?? "-")|\($0.title ?? "-")" }
            .joined(separator: ",")
        let questions = questionItems.map { "\($0.id ?? "-")" }.joined(separator: ",")
        let failed = failedRuns.map { "\($0.id ?? "-")" }.joined(separator: ",")
        return "pending=\(pending) running=\(running) approvals=\(approvals) " +
            "questions=\(self.questions) doneUnread=\(doneUnread) failed=\(self.failed) " +
            "offline=\(offline) idle=\(idle) sessions=[\(sessions)] " +
            "questionRows=[\(questions)] failedRows=[\(failed)] doneRows=[\(done)]"
    }
}

/// 面板详情视图（点「完成未看」行后展示该次外部运行的结果）。
private struct RadarDetail {
    let title: String
    let agent: String
    var meta: String
    var body: String
    /// 正文行数（用于计算面板高度，最多 6 行）。
    var bodyLines: Int {
        guard !body.isEmpty else { return 1 }
        let perLine = 30
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false)
            .reduce(0) { $0 + max(1, ($1.count + perLine - 1) / perLine) }
        return min(6, max(1, lines))
    }

    /// 完整事件流（详情二级视图）。
    var events: [RadarEventLine] = []
    /// 「子会话列表」页要用：父会话 id 和它的子会话。
    var parentId: String = ""
    var children: [RadarChild] = []
    /// 这次运行的 id（用于实时跟随增量拉取）。
    var runId: String = ""
    /// 运行是否仍在进行（决定标题栏是否显示「直播中」并继续轮询）。
    var live: Bool = false
    /// 运行状态文本（running/done/failed）。
    var runStatus: String = ""
    /// 单条事件的原始 payload（三级视图）。
    var rawTitle: String = ""
    var rawLines: [String] = []
    var isSession: Bool = false
    /// 最近几步（给「进行到哪一步」用，不给全量事件流）
    var progressLines: [String] {
        let picked = events.filter { line in
            line.kind == "item.start" || line.kind == "item.end" || line.kind == "status"
        }
        return Array(picked.suffix(3)).map { "· " + $0.text }
    }
}

/// 事件流里的一行：`#seq  kind  text`。
private struct RadarEventLine {
    let seq: Int
    let kind: String
    let text: String
    /// 原始事件（美化后的 JSON），供「点一条看原始」展示。
    let raw: String
}

/// 父会话下面的子会话（父会话调用的智能体）。
private struct RadarStage: Decodable {
    let subject: String?
    let status: String?
}

private struct RadarChild: Decodable {
    var id: String?
    var title: String?
    var role: String?
    var status: String?
    var taskStatus: String?
    var agent: String?
    var preset: String?
    var tokens: Int?
    var updatedAt: Int64?

    var isRunning: Bool { status == "running" }
    var displayTitle: String { title ?? role ?? "（无标题）" }
}

/// 详情面板的形态。
private enum DetailMode {
    case summary
    case events
    case raw
    case approval
    case children
}

/// 详情底部按钮。
private enum DetailAction {
    case backToList
    case showEvents
    case backToSummary
    case backToEvents
    case approve
    case reject
    case answer(Int)
    /// 提问但没有选项：回执一个确认值（「回复」按钮）。
    case confirmAnswer
    case jumpSession
}

// MARK: - 启动参数

private struct Options {
    enum Source {
        case explicit(URL)
        case auto
        case mock(String)
    }

    var source: Source = .auto
    var interval: TimeInterval = HUD.defaultInterval
    /// `--expand`：启动即展开，且不因鼠标离开而收回（截图/验收用）。
    var forceExpanded = false
    /// `--state-dir`：radar-url.json / hud.pid 所在目录（多宿主时每个宿主一份）。
    var stateDir: String?

    static func parse(_ args: [String]) -> (Options, exitCode: Int32?) {
        var opts = Options()
        var i = 1
        var urlArg: String?
        var mockArg: String?

        func value(for flag: String, inline: String?) -> String? {
            if let inline { return inline }
            let next = i + 1
            if next < args.count, !args[next].hasPrefix("--") {
                i = next
                return args[next]
            }
            return nil
        }

        while i < args.count {
            let raw = args[i]
            let parts = raw.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let flag = String(parts[0])
            let inline = parts.count > 1 ? String(parts[1]) : nil

            switch flag {
            case "--help", "-h":
                printUsage()
                return (opts, 0)
            case "--url":
                guard let v = value(for: flag, inline: inline) else {
                    log("error: --url 缺少值")
                    return (opts, 2)
                }
                urlArg = v
            case "--interval":
                guard let v = value(for: flag, inline: inline), let seconds = Double(v) else {
                    log("error: --interval 需要数字（秒），已使用默认 \(HUD.defaultInterval)")
                    break
                }
                if seconds <= 0 {
                    log("warn: --interval 必须 > 0，已使用默认 \(HUD.defaultInterval)")
                } else {
                    opts.interval = min(max(seconds, 0.2), 3600)
                }
            case "--mock":
                guard let v = value(for: flag, inline: inline) else {
                    log("error: --mock 缺少文件路径")
                    return (opts, 2)
                }
                mockArg = v
            case "--expand":
                opts.forceExpanded = true
            case "--state-dir":
                guard let v = value(for: flag, inline: inline) else {
                    log("error: --state-dir 缺少值")
                    return (opts, 2)
                }
                opts.stateDir = v
            default:
                log("warn: 忽略未知参数 \(raw)")
            }
            i += 1
        }

        if let mockArg {
            opts.source = .mock(mockArg)
        } else if let urlArg, urlArg.lowercased() != "auto" {
            guard let url = URL(string: urlArg), let scheme = url.scheme,
                  scheme == "http" || scheme == "https" else {
                log("error: --url 必须是 http(s) URL 或 auto，收到 \(urlArg)")
                return (opts, 2)
            }
            opts.source = .explicit(url)
        } else {
            opts.source = .auto
        }
        return (opts, nil)
    }

    static func printUsage() {
        print("""
        RadarHUD — DSH 任务雷达原生悬浮窗

        Usage:
          RadarHUD --url <radar-json-url> [--interval <seconds>] [--expand]
          RadarHUD --url auto [--interval <seconds>] [--expand]
          RadarHUD --mock <file.json> [--interval <seconds>] [--expand]

        Options:
          --url <url|auto>   雷达 JSON 地址；auto（或缺省）= 每轮读取
                             ~/.dsh/agent-bridge/radar-url.json 的 url 字段，
                             读取失败回退到上一次使用的 URL，再失败显示「离线」。
          --interval <sec>   轮询间隔，默认 2 秒（范围 0.2–3600）。
          --mock <file>      只读本地 JSON 文件，不访问网络（便于自测）。
          --expand           启动即强制展开面板（截图/验收用，鼠标离开也不收回）。
          --state-dir <dir>  状态目录（radar-url.json / hud.pid）；缺省 ~/.dsh/agent-bridge。
                             多宿主并存时宿主会传 hosts/<port>，避免互相覆盖。
          -h, --help         显示本帮助。

        交互：鼠标移入圆形徽标展开面板，离开 250ms 后收回；
              双击（徽标、面板、列表行）才激活 DeepSeek Harness，单击不做事；
              右键菜单：刷新 / 置顶开/关 / 隐藏 5 分钟 / 退出。
        """)
    }
}

// MARK: - 视图

/// 不接受命中测试的透明视图：让事件穿透到 HUD 根视图。
private class PassthroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// 呼吸圆点。颜色 + 1.2s 呼吸动画（0.6s 单程 + autoreverse）。
private final class DotView: PassthroughView {
    private let breathKey = "radar.breath"

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: HUD.dotSize, height: HUD.dotSize))
        wantsLayer = true
        layer?.cornerRadius = HUD.dotSize / 2
        layer?.masksToBounds = true
        configure(color: .systemGray, breathing: false)
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    func configure(color: NSColor, breathing: Bool) {
        guard let layer else { return }
        layer.backgroundColor = color.cgColor

        if breathing {
            if layer.animation(forKey: breathKey) != nil {
                layer.removeAnimation(forKey: breathKey)
            }
            let anim = CABasicAnimation(keyPath: "opacity")
            anim.fromValue = 1.0
            anim.toValue = 0.35
            anim.duration = 0.6 // 单程 0.6s → 一个完整呼吸周期 1.2s
            anim.autoreverses = true
            anim.repeatCount = .infinity
            anim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            layer.add(anim, forKey: breathKey)
        } else {
            layer.removeAnimation(forKey: breathKey)
            layer.opacity = 1.0
        }
    }
}

/// 圆形徽标：收起态的整个窗口，也是展开态右下/左下角的计数徽标。
/// 只画「大数字 + 呼吸圆点」；离线时在圆内底部加一行小字「离线」。
private final class CircleBadgeView: PassthroughView {
    var state = RenderState() {
        didSet { needsDisplay = true }
    }

    /// 0…1 的脉冲相位，仅在有「需批准」时由控制器驱动。
    var pulse: CGFloat = 0 {
        didSet { needsDisplay = true }
    }

    let dotView = DotView()

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: HUD.circleSize, height: HUD.circleSize))
        wantsLayer = true
        layer?.masksToBounds = false
        addSubview(dotView)
        // 圆点位于圆内顶部居中；数字在圆心略偏下，二者不打架。
        dotView.frame = NSRect(x: (HUD.circleSize - HUD.dotSize) / 2,
                               y: HUD.circleSize - HUD.dotSize - 6,
                               width: HUD.dotSize,
                               height: HUD.dotSize)
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        let circle = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(ovalIn: circle)
        NSColor(calibratedWhite: 0.06, alpha: 0.42).setFill()
        path.fill()

        if state.approvals > 0 {
            // 有任务等我批准：整圈变红 + 轻微脉冲。
            // 脉冲只作用在描边宽度/透明度上，圆内保持深色，避免把数字糊掉。
            let wave = (sin(pulse * 2 * .pi) + 1) / 2   // 0…1
            // 整个圆先压一层红，让「有人等我批准」在余光里也看得出来。
            NSColor.systemRed.withAlphaComponent(0.16 + 0.10 * wave).setFill()
            path.fill()
            let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 1.5, dy: 1.5))
            NSColor.systemRed.withAlphaComponent(0.80 + 0.20 * wave).setStroke()
            ring.lineWidth = 2.2 + 1.0 * wave
            ring.stroke()

            let inner = NSBezierPath(ovalIn: bounds.insetBy(dx: 4.5, dy: 4.5))
            NSColor.systemRed.withAlphaComponent(0.10 + 0.14 * wave).setStroke()
            inner.lineWidth = 1
            inner.stroke()
            dotView.configure(color: .systemRed, breathing: true)
        } else if state.doneUnread > 0 {
            // 有任务刚跑完还没看：整圈变绿 + 轻微脉冲（与红色的「等你批准」区分开）。
            let wave = (sin(pulse * 2 * .pi) + 1) / 2
            NSColor.systemGreen.withAlphaComponent(0.12 + 0.10 * wave).setFill()
            path.fill()
            let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 1.5, dy: 1.5))
            NSColor.systemGreen.withAlphaComponent(0.72 + 0.24 * wave).setStroke()
            ring.lineWidth = 2.0 + 0.9 * wave
            ring.stroke()
            dotView.configure(color: .systemGreen, breathing: true)
        } else {
            NSColor(calibratedWhite: 1.0, alpha: 0.22).setStroke()
            path.lineWidth = 1
            path.stroke()
            dotView.configure(color: state.offline ? .systemOrange : .systemGreen, breathing: !state.offline)
        }

        let numberFont = NSFont.systemFont(ofSize: HUD.numberFontSize, weight: .bold)
        let numberColor = state.offline
            ? NSColor(calibratedWhite: 1.0, alpha: 0.50)
            : NSColor(calibratedWhite: 1.0, alpha: 0.96)
        // 数字必须在圆内水平居中：`draw(in:withAttributes:)` 默认左对齐，
        // 之前 56pt 圆里数字被挤到左边缘，看起来像一条竖条。
        let centered = NSMutableParagraphStyle()
        centered.alignment = .center
        let numberAttrs: [NSAttributedString.Key: Any] = [
            .font: numberFont,
            .foregroundColor: numberColor,
            .paragraphStyle: centered,
        ]
        let number = "\(state.taskCount)"
        let numberSize = (number as NSString).size(withAttributes: numberAttrs)
        let numberRect = NSRect(x: 0,
                                y: (bounds.height - numberSize.height) / 2 - 1,
                                width: bounds.width,
                                height: numberSize.height)
        (number as NSString).draw(in: numberRect, withAttributes: numberAttrs)

        if false, let label = state.orbLabel {
            let labelCentered = NSMutableParagraphStyle()
            labelCentered.alignment = .center
            labelCentered.lineBreakMode = .byTruncatingTail
            let labelAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 8.5, weight: .medium),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: state.approvals > 0 ? 0.92 : 0.62),
                .paragraphStyle: labelCentered,
            ]
            (label as NSString).draw(
                in: NSRect(x: 4, y: 13, width: bounds.width - 8, height: 11),
                withAttributes: labelAttrs)
        }

        if state.offline {
            let offlineCentered = NSMutableParagraphStyle()
            offlineCentered.alignment = .center
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 8.5, weight: .medium),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.55),
                .paragraphStyle: offlineCentered,
            ]
            let text = "离线" as NSString
            let size = text.size(withAttributes: attrs)
            let rect = NSRect(x: 0, y: 3, width: bounds.width, height: size.height)
            text.draw(in: rect, withAttributes: attrs)
        }
    }
}

/// 展开态面板内容：描边 + 标题 + 任务列表 + 状态副行。
/// 圆形徽标是独立子视图，绘制在面板之上；本视图不画圆。
private final class PanelContentView: PassthroughView {
    var state = RenderState() {
        didSet { needsDisplay = true }
    }
    var expanded = false {
        didSet { needsDisplay = true }
    }
    var growLeft = true
    var growUp = true

    override var isOpaque: Bool { false }

    /// 「完成未看」行的可点击区域（视图坐标），每次绘制时重建。
    private var doneRowHits: [(rect: NSRect, id: String)] = []
    private var artifactRowHits: [(rect: NSRect, path: String)] = []

    func artifactRowPath(at point: NSPoint) -> String? {
        for hit in artifactRowHits where hit.rect.contains(point) {
            return hit.path
        }
        return nil
    }

    /// 详情视图（非 nil 时面板整块改为结果展示）。
    var detail: RadarDetail? {
        didSet { needsDisplay = true }
    }

    /// 详情形态：摘要 / 完整事件流。
    var detailMode: DetailMode = .summary {
        didSet {
            eventScrollRow = 0
            rawScrollRow = 0
            needsDisplay = true
        }
    }

    /// 事件流当前顶部行号（滚动状态只属于视图，控制器不参与）。
    private var eventScrollRow = 0

    /// 原始 payload 视图的顶部行号。
    private var rawScrollRow = 0

    /// 事件流每一行的点击区域（点一行 → 看该事件的原始 JSON）。
    private var eventRowHits: [(rect: NSRect, index: Int)] = []

    func eventRowIndex(at point: NSPoint) -> Int? {
        for hit in eventRowHits where hit.rect.contains(point) {
            return hit.index
        }
        return nil
    }

    /// 详情底部按钮的点击区域。
    private var detailActionHits: [(rect: NSRect, action: DetailAction)] = []
    /// 当前提问的可点选项：label 与它所属 questionId，点选后回执 {qid: label}（2.20）。
    var questionChoices: [(questionId: String, label: String)] = []
    /// 当前详情是不是「提问」类（无选项时把底部按钮换成「回复 / 取消」）。
    var isQuestionDetail = false
    /// 无选项提问时用来回执的 question id（取第一个问题的 id）。
    var questionIdFallback: String?

    func detailActionHit(at point: NSPoint) -> DetailAction? {
        for hit in detailActionHits where hit.rect.contains(point) {
            return hit.action
        }
        return nil
    }

    /// 「完成未看 N」副行的点击区域：点它等于「全部置为已读」。
    private var doneStatsRect: NSRect?

    func doneStatsHit(at point: NSPoint) -> Bool {
        guard let rect = doneStatsRect else { return false }
        return rect.contains(point)
    }

    /// 运行中的外部任务行（点开看实时事件）。
    private var liveRowHits: [(rect: NSRect, id: String)] = []
    /// DSH 会话行（点了跳回那条会话）。
    private var sessionRowHits: [(rect: NSRect, id: String)] = []
    private var childRowHits: [(rect: NSRect, id: String)] = []
    /// 待批准行（点开在面板里直接批准/拒绝）。
    private var approvalRowHits: [(rect: NSRect, id: String, approvalId: String)] = []

    func approvalRowHit(at point: NSPoint) -> (id: String, approvalId: String)? {
        for hit in approvalRowHits where hit.rect.contains(point) {
            return (hit.id, hit.approvalId)
        }
        return nil
    }

    /// 子会话行命中（点它跳到那条子会话）。
    func childRowId(at point: NSPoint) -> String? {
        for hit in childRowHits where hit.rect.contains(point) { return hit.id }
        return nil
    }

    func sessionRowId(at point: NSPoint) -> String? {
        for hit in sessionRowHits where hit.rect.contains(point) {
            return hit.id
        }
        return nil
    }

    func liveRowId(at point: NSPoint) -> String? {
        for hit in liveRowHits where hit.rect.contains(point) {
            return hit.id
        }
        return nil
    }

    /// 命中「完成未看」行则返回该 run id，供控制器置为已读。
    func doneRowId(at point: NSPoint) -> String? {
        for hit in doneRowHits where hit.rect.contains(point) {
            return hit.id
        }
        return nil
    }

    private let badgeColors: [NSColor] = [
        .systemBlue, .systemPurple, .systemTeal,
        .systemOrange, .systemPink, .systemGreen, .systemIndigo,
    ]

    override func draw(_ dirtyRect: NSRect) {
        guard expanded, alphaValue > 0.01 else { return }

        // 根视图不再提供材质，面板自己画深色底 + 描边。
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
                                 xRadius: HUD.panelCorner,
                                 yRadius: HUD.panelCorner)
        NSColor(calibratedWhite: 0.08, alpha: 0.90).setFill()
        shape.fill()
        NSColor(calibratedWhite: 1.0, alpha: 0.16).setStroke()
        shape.lineWidth = 1
        shape.stroke()

        doneStatsRect = nil
        detailActionHits = []
        eventRowHits = []

        if let detail {
            switch detailMode {
            case .events:
                drawEvents(detail)
            case .raw:
                drawRaw(detail)
            case .summary:
                drawDetail(detail)
            case .approval:
                drawApproval(detail)
            case .children:
                drawChildren(detail)
            }
            return
        }

        let padding = HUD.contentPadding
        let band = HUD.bandHeight
        let contentMinY = growUp ? band : padding
        let contentMaxY = growUp ? bounds.height - padding : bounds.height - band
        let headerY = contentMaxY - HUD.headerHeight

        // 标题行
        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.90),
        ]
        ("任务" as NSString).draw(in: NSRect(x: padding, y: headerY + 10,
                                              width: 160, height: 18),
                                   withAttributes: titleAttrs)

        let rows = state.panelRows
        var headerRight = "\(rows.count) 项"
        let teamKids = rows.filter { $0.team == true }.flatMap { $0.children ?? [] }
        if !teamKids.isEmpty {
            let done = teamKids.filter { ($0.taskStatus ?? "").contains("已完成") }.count
            headerRight = "\(done)/\(teamKids.count) 完成"
        }
        let statusText = state.offline ? "离线" : headerRight
        let statusColor = state.offline
            ? NSColor.systemOrange.withAlphaComponent(0.85)
            : NSColor(calibratedWhite: 1.0, alpha: 0.42)
        let para = NSMutableParagraphStyle()
        para.alignment = .right
        para.lineBreakMode = .byTruncatingTail
        let statusAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
            .foregroundColor: statusColor,
            .paragraphStyle: para,
        ]
        (statusText as NSString).draw(in: NSRect(x: bounds.width - padding - 120,
                                                y: headerY + 11,
                                                width: 120, height: 16),
                                     withAttributes: statusAttrs)

        // 标题下分隔线
        let sep = NSBezierPath()
        sep.move(to: NSPoint(x: padding, y: headerY + 4))
        sep.line(to: NSPoint(x: bounds.width - padding, y: headerY + 4))
        NSColor(calibratedWhite: 1.0, alpha: 0.08).setStroke()
        sep.lineWidth = 1
        sep.stroke()

        let listTop = headerY - 2
        let visible = Array(rows.prefix(HUD.maxRows))
        doneRowHits.removeAll()
        artifactRowHits.removeAll()
        liveRowHits.removeAll()
        sessionRowHits.removeAll()
        approvalRowHits.removeAll()
        if visible.isEmpty {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11, weight: .regular),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.40),
            ]
            ("暂无任务" as NSString).draw(
                in: NSRect(x: padding, y: contentMinY + 8,
                           width: bounds.width - 2 * padding, height: 18),
                withAttributes: attrs)
        } else {
            for (index, item) in visible.enumerated() {
                let y = listTop - CGFloat(index + 1) * HUD.rowHeight
                let rect = NSRect(x: padding, y: y,
                                  width: bounds.width - 2 * padding,
                                  height: HUD.rowHeight)
                let doneUnread = item.isDoneUnreadRun
                let asks = item.isApproval || item.isQuestion
                drawRow(item, index: index, in: rect, doneUnread: doneUnread, approval: asks)
                if asks, let id = item.id, let approvalId = item.approvalId {
                    approvalRowHits.append((rect: rect, id: id, approvalId: approvalId))
                } else if doneUnread, let id = item.id {
                    doneRowHits.append((rect: rect, id: id))
                } else if item.isRunningRun || item.isReviewRun || item.isFailedRun, let id = item.id {
                    // 失败的 run 也登记成「可点开看错误」的实时行，否则它只是一行死字。
                    liveRowHits.append((rect: rect, id: id))
                } else if item.isRunningSession, let id = item.id {
                    sessionRowHits.append((rect: rect, id: id))
                } else if item.isArtifact, let path = item.path {
                    artifactRowHits.append((rect: rect, path: path))
                }
            }
            if rows.count > HUD.maxRows {
                let y = listTop - CGFloat(HUD.maxRows) * HUD.rowHeight - HUD.overflowHeight + 4
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: NSFont.systemFont(ofSize: 10, weight: .regular),
                    .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.38),
                ]
                ("还有 \(rows.count - HUD.maxRows) 条" as NSString).draw(
                    in: NSRect(x: padding, y: y,
                               width: bounds.width - 2 * padding, height: 16),
                    withAttributes: attrs)
            }
        }

        drawStats(in: growUp
                  ? NSRect(x: 0, y: 0, width: bounds.width, height: band)
                  : NSRect(x: 0, y: bounds.height - band, width: bounds.width, height: band))
    }

    /// 待验收类状态的副标题文案（R8 通知门：完成 ≠ 通过验收）。
    private func reviewSubtitle(_ item: RadarItem) -> String? {
        guard item.isReviewRun else { return nil }
        switch item.status ?? "" {
        case "verifying": return "待验收 · 点击看进展"
        case "rework": return "返工中 \(item.round ?? 1)/2 · 点击看缺什么"
        case "blocked": return "需你决定 · 点击看"
        case "unverified": return "未验证完成 · 还没通过验收"
        default: return nil
        }
    }

    private func drawRow(_ item: RadarItem, index: Int, in rect: NSRect,
                         doneUnread: Bool = false, approval: Bool = false) {
        let badgeSize: CGFloat = 22
        let badgeRect = NSRect(x: rect.minX, y: rect.midY - badgeSize / 2,
                               width: badgeSize, height: badgeSize)
        let color = approval
            ? NSColor.systemOrange
            : (doneUnread
                ? NSColor(calibratedWhite: 0.58, alpha: 1.0)
                : badgeColor(for: item.agent ?? ""))
        let badgePath = NSBezierPath(roundedRect: badgeRect, xRadius: 6, yRadius: 6)
        color.withAlphaComponent(doneUnread ? 0.55 : 0.82).setFill()
        badgePath.fill()

        let initial = badgeInitial(for: item.agent)
        let initialAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .bold),
            .foregroundColor: NSColor.white.withAlphaComponent(0.95),
        ]
        let initialSize = (initial as NSString).size(withAttributes: initialAttrs)
        (initial as NSString).draw(in: NSRect(x: badgeRect.midX - initialSize.width / 2,
                                              y: badgeRect.midY - initialSize.height / 2,
                                              width: initialSize.width,
                                              height: initialSize.height),
                                   withAttributes: initialAttrs)

        let textX = badgeRect.maxX + 10
        let textWidth = rect.maxX - textX
        let title = (item.title?.isEmpty == false ? item.title! : "（无标题）") as NSString
        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12.5, weight: .medium),
            .foregroundColor: NSColor(calibratedWhite: 1.0,
                                      alpha: doneUnread ? 0.74 : (approval ? 0.97 : 0.92)),
        ]
        title.draw(in: NSRect(x: textX, y: rect.minY + 20, width: textWidth, height: 17),
                   withAttributes: titleAttrs)

        var agentText: String
        if let review = reviewSubtitle(item) {
            agentText = "\((item.agent ?? "unknown").uppercased()) · \(review)"
        } else if item.isQuestion {
            agentText = "\((item.agent ?? "unknown").uppercased()) · 等你回答 · 点击处理"
        } else if item.isFailedRun {
            let reason = item.finalAnswer?.trimmingCharacters(in: .whitespacesAndNewlines)
            agentText = "\((item.agent ?? "unknown").uppercased()) · 失败 · " +
                (reason?.isEmpty == false ? String((reason ?? "").prefix(28)) : "点击看日志")
        } else if approval {
            agentText = "\((item.agent ?? "unknown").uppercased()) · 待批准 · 点击处理"
        } else if doneUnread {
            agentText = "\((item.agent ?? "unknown").uppercased()) · 完成未看 · 点击标记已读"
        } else {
            agentText = (item.agent ?? "unknown").uppercased()
        }
        if !approval, !doneUnread, item.team == true, let count = item.childCount, count > 0 {
            let kids = item.children ?? []
            let done = kids.filter { ($0.taskStatus ?? "").contains("已完成") }.count
            let current = kids.first { $0.isRunning }
            var teamText = " \(done)/\(count) 完成"
            if let current, current.id != item.id {
                let label = current.role ?? current.displayTitle
                teamText += " · 当前 \(label)"
            }
            agentText += teamText
        }
        let agent = agentText as NSString
        let agentAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9, weight: .regular),
            .foregroundColor: approval
                ? NSColor.systemOrange.withAlphaComponent(0.85)
                : NSColor(calibratedWhite: 1.0, alpha: doneUnread ? 0.52 : 0.42),
        ]
        agent.draw(in: NSRect(x: textX, y: rect.minY + 5, width: textWidth, height: 13),
                   withAttributes: agentAttrs)

        if index < HUD.maxRows - 1 {
            let line = NSBezierPath()
            line.move(to: NSPoint(x: rect.minX, y: rect.minY + 0.5))
            line.line(to: NSPoint(x: rect.maxX, y: rect.minY + 0.5))
            NSColor(calibratedWhite: 1.0, alpha: 0.05).setStroke()
            line.lineWidth = 1
            line.stroke()
        }
    }

    /// 详情页：标题 / agent·耗时·token / 正文（最多 6 行）/ 底部返回提示。
    private func drawDetail(_ detail: RadarDetail) {
        let padding = HUD.contentPadding
        let headerY = bounds.height - padding - HUD.headerHeight

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.90),
        ]
        ((detail.live ? "正在进行" : "任务结果") as NSString).draw(
            in: NSRect(x: padding, y: headerY + 10, width: 160, height: 18),
            withAttributes: titleAttrs)

        // 右侧 agent 徽标文字
        let agentText = detail.agent.uppercased() as NSString
        let agentAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9, weight: .medium),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.50),
        ]
        let agentSize = agentText.size(withAttributes: agentAttrs)
        agentText.draw(in: NSRect(x: bounds.width - padding - agentSize.width,
                                  y: headerY + 13,
                                  width: agentSize.width, height: 14),
                       withAttributes: agentAttrs)

        var y = headerY - 6

        // 任务标题
        let titleText = (detail.title.isEmpty ? "（无标题）" : detail.title) as NSString
        let rowTitleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12.5, weight: .medium),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.92),
        ]
        titleText.draw(in: NSRect(x: padding, y: y - 16, width: bounds.width - 2 * padding, height: 17),
                       withAttributes: rowTitleAttrs)
        y -= 22

        // 元信息（耗时/token/时间）
        let metaAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.46),
        ]
        (detail.meta as NSString).draw(in: NSRect(x: padding, y: y - 12, width: bounds.width - 2 * padding, height: 13),
                                       withAttributes: metaAttrs)
        y -= 18

        // 最近步骤（进行中主要看这个）
        let steps = detail.progressLines
        if !steps.isEmpty {
            let stepAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10, weight: .regular),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.62),
            ]
            for (index, line) in steps.enumerated() {
                (line as NSString).draw(
                    in: NSRect(x: padding, y: y - CGFloat(index + 1) * 13 + 2,
                               width: bounds.width - 2 * padding, height: 13),
                    withAttributes: stepAttrs)
            }
            y -= CGFloat(steps.count) * 13 + 4
        }

        // 分隔线
        let sep = NSBezierPath()
        sep.move(to: NSPoint(x: padding, y: y + 2))
        sep.line(to: NSPoint(x: bounds.width - padding, y: y + 2))
        NSColor(calibratedWhite: 1.0, alpha: 0.08).setStroke()
        sep.lineWidth = 1
        sep.stroke()

        // 正文
        let bodyPara = NSMutableParagraphStyle()
        bodyPara.lineBreakMode = .byTruncatingTail
        bodyPara.lineSpacing = 2
        let bodyAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.82),
            .paragraphStyle: bodyPara,
        ]
        let bodyHeight = CGFloat(detail.bodyLines) * 15
        let bodyRect = NSRect(x: padding, y: y - bodyHeight, width: bounds.width - 2 * padding,
                              height: bodyHeight)
        (((detail.body.isEmpty ? "（本次运行没有文本输出）" : detail.body)) as NSString)
            .draw(with: bodyRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                  attributes: bodyAttrs)

        // 底部按钮：左「返回列表」，右「完整事件流」
        drawFooterButton(text: "‹ 返回列表", align: .left, action: .backToList)
        if detail.isSession {
            drawFooterButton(text: "跳到会话 ›", align: .right, action: .jumpSession)
        } else {
            drawFooterButton(text: "事件流 \(detail.events.count) 条 ›", align: .right, action: .showEvents)
        }
    }

    /// 审批视图：一句话说明 agent 想干什么，底部直接批准/拒绝。
    private func drawApproval(_ detail: RadarDetail) {
        let padding = HUD.contentPadding
        let headerY = bounds.height - padding - HUD.headerHeight

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.systemOrange.withAlphaComponent(0.95),
        ]
        ("任务审批" as NSString).draw(
            in: NSRect(x: padding, y: headerY + 10, width: 160, height: 18),
            withAttributes: titleAttrs)

        var y = headerY - 6

        let titleText = (detail.title.isEmpty ? "（无描述）" : detail.title) as NSString
        let rowTitleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.94),
        ]
        titleText.draw(in: NSRect(x: padding, y: y - 16, width: bounds.width - 2 * padding, height: 17),
                       withAttributes: rowTitleAttrs)
        y -= 22

        let metaAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.46),
        ]
        (detail.meta as NSString).draw(in: NSRect(x: padding, y: y - 12, width: bounds.width - 2 * padding, height: 13),
                                       withAttributes: metaAttrs)
        y -= 16

        let sep = NSBezierPath()
        sep.move(to: NSPoint(x: padding, y: y + 2))
        sep.line(to: NSPoint(x: bounds.width - padding, y: y + 2))
        NSColor(calibratedWhite: 1.0, alpha: 0.08).setStroke()
        sep.lineWidth = 1
        sep.stroke()

        // 正文 = agent 想执行的命令/它的理由（自动折行，最多几行）
        let bodyPara = NSMutableParagraphStyle()
        bodyPara.lineBreakMode = .byTruncatingTail
        bodyPara.lineSpacing = 2
        let bodyAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.80),
            .paragraphStyle: bodyPara,
        ]
        let bodyHeight = CGFloat(max(1, detail.bodyLines)) * 15
        let bodyRect = NSRect(x: padding, y: y - bodyHeight, width: bounds.width - 2 * padding,
                              height: bodyHeight)
        ((detail.body.isEmpty ? "（没有可展示的命令）" : detail.body) as NSString)
            .draw(with: bodyRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                  attributes: bodyAttrs)

        // 提问：把每个选项画成一行可点按钮（2.20）。点中即把
        // {questionId: label} 回给 agent，而不是 allow/deny。
        if !questionChoices.isEmpty {
            var optionY = y - bodyHeight - 10
            let optionAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
                .foregroundColor: NSColor.white.withAlphaComponent(0.96),
            ]
            for (index, choice) in questionChoices.enumerated() {
                let rect = NSRect(x: padding, y: optionY - 18, width: bounds.width - 2 * padding, height: 20)
                if rect.minY < HUD.contentPadding + 26 { break }
                let path = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
                NSColor.systemBlue.withAlphaComponent(0.30).setFill()
                path.fill()
                let label = "\(index + 1). \(choice.label)" as NSString
                label.draw(in: NSRect(x: rect.minX + 8, y: rect.minY + 4, width: rect.width - 16, height: 14),
                           withAttributes: optionAttrs)
                detailActionHits.append((rect: rect, action: .answer(index)))
                optionY -= 24
            }
            drawFooterButton(text: "✕ 取消", align: .left, action: .reject,
                             color: NSColor.white.withAlphaComponent(0.95),
                             background: NSColor.systemRed.withAlphaComponent(0.72))
            return
        }

        // 底部：左「拒绝」（红），右「批准」（绿）
        if isQuestionDetail {
            // 无选项提问：不能给「批准/拒绝」这种语义，退化成「回复 / 取消」。
            drawFooterButton(text: "✕ 取消", align: .left, action: .reject,
                             color: NSColor.white.withAlphaComponent(0.95),
                             background: NSColor.systemRed.withAlphaComponent(0.72))
            drawFooterButton(text: "✎ 回答…", align: .right, action: .confirmAnswer,
                             color: NSColor.white.withAlphaComponent(0.98),
                             background: NSColor.systemBlue.withAlphaComponent(0.72))
            return
        }
        drawFooterButton(text: "✕ 拒绝", align: .left, action: .reject,
                         color: NSColor.white.withAlphaComponent(0.95),
                         background: NSColor.systemRed.withAlphaComponent(0.72))
        drawFooterButton(text: "✓ 批准", align: .right, action: .approve,
                         color: NSColor.white.withAlphaComponent(0.98),
                         background: NSColor.systemGreen.withAlphaComponent(0.72))
    }

    /// 详情页底部按钮（左/右对齐），点击区域记进 detailActionHits。
    private func drawFooterButton(text: String, align: NSTextAlignment, action: DetailAction,
                                  color: NSColor? = nil, background: NSColor? = nil) {
        let padding = HUD.contentPadding
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9.5, weight: .medium),
            .foregroundColor: color ?? NSColor(calibratedWhite: 1.0, alpha: 0.52),
        ]
        let size = (text as NSString).size(withAttributes: attrs)
        let x = align == .left ? padding : bounds.width - padding - size.width
        let rect = NSRect(x: x - 4, y: HUD.contentPadding - 4,
                          width: size.width + 8, height: 18)
        if let background {
            let path = NSBezierPath(roundedRect: rect, xRadius: 5, yRadius: 5)
            background.setFill()
            path.fill()
        }
        detailActionHits.append((rect: rect, action: action))
        let para = NSMutableParagraphStyle()
        para.alignment = align
        let attrs2 = attrs.merging([.paragraphStyle: para]) { $1 }
        (text as NSString).draw(in: NSRect(x: rect.minX + 4, y: rect.minY + 4,
                                          width: rect.width - 8, height: size.height),
                                withAttributes: attrs2)
    }

    /// 底部纯提示文字（不可点）。
    private func drawFooterLabel(text: String, align: NSTextAlignment) {
        let padding = HUD.contentPadding
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.36),
        ]
        let size = (text as NSString).size(withAttributes: attrs)
        let x = align == .left ? padding : bounds.width - padding - size.width
        (text as NSString).draw(in: NSRect(x: x, y: HUD.contentPadding, width: size.width, height: 14),
                                withAttributes: attrs)
    }

    /// 事件流二级视图：每行 `#seq  kind  text`，滚轮翻页。
    private func drawEvents(_ detail: RadarDetail) {
        let padding = HUD.contentPadding
        let headerY = bounds.height - padding - HUD.headerHeight

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.90),
        ]
        ("事件流" as NSString).draw(
            in: NSRect(x: padding, y: headerY + 10, width: 160, height: 18),
            withAttributes: titleAttrs)

        let total = detail.events.count
        let visible = HUD.eventVisibleRows
        let first = min(max(0, eventScrollRow), max(0, total - 1))
        let last = min(total, first + visible)
        let counter = "\(first + 1)-\(last)/\(total)"
        let counterAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.44),
        ]
        let counterSize = (counter as NSString).size(withAttributes: counterAttrs)
        (counter as NSString).draw(in: NSRect(x: bounds.width - padding - counterSize.width,
                                             y: headerY + 13,
                                             width: counterSize.width, height: 14),
                                   withAttributes: counterAttrs)

        // 「直播中」：这次运行还没结束时，新事件会自动追加。
        if detail.live {
            let liveText = "● 直播中"
            let liveAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 9, weight: .medium),
                .foregroundColor: NSColor(calibratedRed: 0.45, green: 0.92, blue: 0.62, alpha: 0.95),
            ]
            let size = (liveText as NSString).size(withAttributes: liveAttrs)
            (liveText as NSString).draw(
                in: NSRect(x: bounds.width - padding - counterSize.width - size.width - 8,
                           y: headerY + 13, width: size.width, height: 14),
                withAttributes: liveAttrs)
        }

        var y = headerY - 8
        let rowHeight: CGFloat = 15
        for index in first..<last {
            let line = detail.events[index]
            let seqAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .regular),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.32),
            ]
            let kindAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 9, weight: .medium),
                .foregroundColor: kindColor(line.kind),
            ]
            let textAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10, weight: .regular),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.78),
            ]
            ("#\(line.seq)" as NSString).draw(in: NSRect(x: padding, y: y, width: 30, height: 13),
                                              withAttributes: seqAttrs)
            let kind = line.kind.uppercased() as NSString
            let kindSize = kind.size(withAttributes: kindAttrs)
            kind.draw(in: NSRect(x: padding + 32, y: y, width: min(kindSize.width, 62), height: 13),
                      withAttributes: kindAttrs)
            let textWidth = bounds.width - (padding + 32 + 64) - padding
            (line.text as NSString).draw(
                in: NSRect(x: padding + 32 + 64, y: y, width: max(20, textWidth), height: 13),
                withAttributes: textAttrs)
            eventRowHits.append((rect: NSRect(x: 0, y: y - 2,
                                              width: bounds.width, height: rowHeight),
                                 index: index))
            y -= rowHeight
        }
        if total == 0 {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10, weight: .regular),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.44),
            ]
            ("（这次运行没有可展示的事件）" as NSString).draw(in: NSRect(x: padding, y: y, width: bounds.width - 2 * padding, height: 14),
                                                  withAttributes: attrs)
        }

        // 滚动条
        if total > visible {
            let trackHeight: CGFloat = CGFloat(visible) * rowHeight
            let trackRect = NSRect(x: bounds.width - 5, y: y + rowHeight - 2, width: 2, height: trackHeight)
            NSColor(calibratedWhite: 1.0, alpha: 0.10).setFill()
            trackRect.fill()
            let ratio = CGFloat(visible) / CGFloat(total)
            let thumbHeight = max(12, trackHeight * ratio)
            let maxScroll = CGFloat(max(1, total - visible))
            let offset = CGFloat(first) / maxScroll
            let thumbY = trackRect.maxY - thumbHeight - (trackRect.height - thumbHeight) * offset
            NSColor(calibratedWhite: 1.0, alpha: 0.34).setFill()
            NSBezierPath(roundedRect: NSRect(x: trackRect.minX, y: thumbY, width: 2, height: thumbHeight),
                         xRadius: 1, yRadius: 1).fill()
        }

        drawFooterButton(text: "‹ 返回结果", align: .left, action: .backToSummary)
        drawFooterLabel(text: "点一条看原始", align: .right)
    }

    private func kindColor(_ kind: String) -> NSColor {
        switch kind {
        case "text": return NSColor(calibratedRed: 0.42, green: 0.78, blue: 1.0, alpha: 0.95)
        case "reasoning": return NSColor(calibratedWhite: 1.0, alpha: 0.42)
        case "item.start", "item.end": return NSColor(calibratedRed: 0.62, green: 0.86, blue: 0.58, alpha: 0.9)
        case "turn.start", "turn.end": return NSColor(calibratedRed: 1.0, green: 0.78, blue: 0.42, alpha: 0.95)
        case "usage": return NSColor(calibratedWhite: 1.0, alpha: 0.50)
        default: return NSColor(calibratedWhite: 1.0, alpha: 0.56)
        }
    }

    /// 事件流翻页（由根视图把滚轮事件转进来；PassthroughView 的 hitTest 返回 nil，
    /// 面板自己收不到 scrollWheel）。
    /// 事件流是否已经滚到底（只有本来就在底部的才自动跟随新事件）。
    func eventsAtBottom(_ detail: RadarDetail) -> Bool {
        let maxRow = max(0, detail.events.count - HUD.eventVisibleRows)
        return eventScrollRow >= maxRow
    }

    /// 追加事件后把视图钉到最新一屏。
    func followEventsTail(_ detail: RadarDetail) {
        let maxRow = max(0, detail.events.count - HUD.eventVisibleRows)
        if eventScrollRow != maxRow {
            eventScrollRow = maxRow
            needsDisplay = true
        }
    }

    func scrollEvents(by deltaY: CGFloat) {
        guard detailMode == .events, let detail else { return }
        let visible = HUD.eventVisibleRows
        let maxRow = max(0, detail.events.count - visible)
        var step = Int((-deltaY / 5).rounded())
        if step == 0 { step = deltaY > 0 ? 1 : (deltaY < 0 ? -1 : 0) }
        let next = min(max(0, eventScrollRow + step), maxRow)
        if next != eventScrollRow {
            eventScrollRow = next
            needsDisplay = true
            log("events scroll row=\(next+1)/\(detail.events.count)")
        }
    }

    /// 单条事件的原始 payload：等宽字体 + 逐行滚动。
    /// 子会话列表：父会话展开后看到它调用了哪些智能体、各自在干什么。
    private func drawChildren(_ detail: RadarDetail) {
        let padding = HUD.contentPadding
        let contentMaxY = bounds.height - padding
        let headerY = contentMaxY - HUD.headerHeight
        childRowHits.removeAll()
        detailActionHits.removeAll()

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.92),
        ]
        ("团队成员" as NSString).draw(in: NSRect(x: padding, y: headerY + 11, width: 200, height: 17),
                                  withAttributes: titleAttrs)
        let countAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.45),
        ]
        let countText = "\(detail.children.count) 人"
        (countText as NSString).draw(in: NSRect(x: bounds.width - padding - 120, y: headerY + 12,
                                                width: 120, height: 16),
                                     withAttributes: countAttrs)

        let sep = NSBezierPath()
        sep.move(to: NSPoint(x: padding, y: headerY + 4))
        sep.line(to: NSPoint(x: bounds.width - padding, y: headerY + 4))
        NSColor(calibratedWhite: 1.0, alpha: 0.08).setStroke()
        sep.lineWidth = 1
        sep.stroke()

        let listTop = headerY - 2
        let visible = Array(detail.children.prefix(6))
        for (index, child) in visible.enumerated() {
            let y = listTop - CGFloat(index + 1) * HUD.rowHeight
            let rect = NSRect(x: padding, y: y, width: bounds.width - 2 * padding, height: HUD.rowHeight)
            let badgeRect = NSRect(x: rect.minX, y: rect.midY - 11, width: 22, height: 22)
            let color = child.isRunning ? NSColor.systemGreen : NSColor(calibratedWhite: 0.55, alpha: 1.0)
            let badgePath = NSBezierPath(roundedRect: badgeRect, xRadius: 6, yRadius: 6)
            color.withAlphaComponent(0.80).setFill()
            badgePath.fill()
            let initial = badgeInitial(for: child.agent ?? child.preset, fallback: child.role ?? child.title)
            let initialAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11, weight: .bold),
                .foregroundColor: NSColor.white.withAlphaComponent(0.95),
            ]
            let initialSize = (initial as NSString).size(withAttributes: initialAttrs)
            (initial as NSString).draw(in: NSRect(x: badgeRect.midX - initialSize.width / 2,
                                                  y: badgeRect.midY - initialSize.height / 2,
                                                  width: initialSize.width,
                                                  height: initialSize.height),
                                       withAttributes: initialAttrs)
            let textX = badgeRect.maxX + 10
            let titleAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 12.5, weight: .medium),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.90),
            ]
            (child.displayTitle as NSString).draw(
                in: NSRect(x: textX, y: rect.minY + 20, width: rect.maxX - textX, height: 17),
                withAttributes: titleAttrs)
            var meta = child.isRunning ? "进行中" : "空闲"
            if let taskStatus = child.taskStatus, !taskStatus.isEmpty { meta += " · 任务 \(taskStatus)" }
            if let tokens = child.tokens, tokens > 0 {
                meta += tokens >= 1000 ? String(format: " · %.1fk tokens", Double(tokens) / 1000) : " · \(tokens) tokens"
            }
            let metaAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 9, weight: .regular),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.46),
            ]
            (meta as NSString).draw(in: NSRect(x: textX, y: rect.minY + 5, width: rect.maxX - textX, height: 13),
                                    withAttributes: metaAttrs)
            if index < visible.count - 1 {
                let line = NSBezierPath()
                line.move(to: NSPoint(x: textX, y: rect.minY))
                line.line(to: NSPoint(x: rect.maxX, y: rect.minY))
                NSColor(calibratedWhite: 1.0, alpha: 0.06).setStroke()
                line.lineWidth = 1
                line.stroke()
            }
            if let id = child.id { childRowHits.append((rect: rect, id: id)) }
        }
        drawFooterButton(text: "‹ 返回列表", align: .left, action: .backToList)
        drawFooterLabel(text: detail.children.isEmpty ? "没有子会话" : "点成员跳转", align: .right)
    }

    private func drawRaw(_ detail: RadarDetail) {
        let padding = HUD.contentPadding
        let headerY = bounds.height - padding - HUD.headerHeight

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.90),
        ]
        ("原始事件" as NSString).draw(
            in: NSRect(x: padding, y: headerY + 10, width: 160, height: 18),
            withAttributes: titleAttrs)

        let counterAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.44),
        ]
        let counter = detail.rawTitle as NSString
        let counterSize = counter.size(withAttributes: counterAttrs)
        counter.draw(in: NSRect(x: bounds.width - padding - counterSize.width,
                                y: headerY + 13, width: counterSize.width, height: 14),
                     withAttributes: counterAttrs)

        let lines = detail.rawLines
        let total = lines.count
        let visible = HUD.rawVisibleRows
        let first = min(max(0, rawScrollRow), max(0, total - 1))
        let last = min(total, first + visible)
        let monoAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.80),
        ]
        let dimAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 9, weight: .regular),
            .foregroundColor: NSColor(calibratedRed: 0.70, green: 0.82, blue: 1.0, alpha: 0.70),
        ]
        var y = headerY - 8
        let rowHeight: CGFloat = 13
        if total == 0 {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10, weight: .regular),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.44),
            ]
            ("（这条事件没有原始 payload）" as NSString).draw(
                in: NSRect(x: padding, y: y, width: bounds.width - 2 * padding, height: 14),
                withAttributes: attrs)
        } else {
            for index in first..<last {
                let text = lines[index] as NSString
                let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
                let attrs = trimmed.hasPrefix("\"") || trimmed.hasPrefix("{") || trimmed.hasPrefix("}")
                    ? monoAttrs : dimAttrs
                text.draw(in: NSRect(x: padding, y: y, width: bounds.width - 2 * padding, height: 12),
                          withAttributes: attrs)
                y -= rowHeight
            }
        }

        if total > visible {
            let trackHeight: CGFloat = CGFloat(visible) * rowHeight
            let trackRect = NSRect(x: bounds.width - 5, y: y + rowHeight - 2, width: 2, height: trackHeight)
            NSColor(calibratedWhite: 1.0, alpha: 0.10).setFill()
            trackRect.fill()
            let ratio = CGFloat(visible) / CGFloat(total)
            let thumbHeight = max(12, trackHeight * ratio)
            let maxScroll = CGFloat(max(1, total - visible))
            let offset = CGFloat(first) / maxScroll
            let thumbY = trackRect.maxY - thumbHeight - (trackRect.height - thumbHeight) * offset
            NSColor(calibratedWhite: 1.0, alpha: 0.34).setFill()
            NSBezierPath(roundedRect: NSRect(x: trackRect.minX, y: thumbY, width: 2, height: thumbHeight),
                         xRadius: 1, yRadius: 1).fill()
        }

        drawFooterButton(text: "‹ 返回事件流", align: .left, action: .backToEvents)
        drawFooterLabel(text: "滚轮翻页", align: .right)
    }

    /// 原始 payload 翻页。
    func scrollRaw(by deltaY: CGFloat) {
        guard detailMode == .raw, let detail else { return }
        let visible = HUD.rawVisibleRows
        let maxRow = max(0, detail.rawLines.count - visible)
        var step = Int((-deltaY / 5).rounded())
        if step == 0 { step = deltaY > 0 ? 1 : (deltaY < 0 ? -1 : 0) }
        let next = min(max(0, rawScrollRow + step), maxRow)
        if next != rawScrollRow {
            rawScrollRow = next
            needsDisplay = true
            log("raw scroll row=\(next+1)/\(detail.rawLines.count)")
        }
    }

    private func drawStats(in bandRect: NSRect) {
        let lines = state.statLines
        guard !lines.isEmpty else { return }

        let statsWidth = bounds.width - HUD.bandHeight - HUD.contentPadding * 2
        let statsX = growLeft
            ? HUD.contentPadding
            : HUD.bandHeight + HUD.contentPadding
        let lineHeight: CGFloat = 15
        let blockHeight = CGFloat(lines.count) * lineHeight +
            CGFloat(max(0, lines.count - 1)) * 2
        let bottom = bandRect.midY - blockHeight / 2

        for (index, line) in lines.enumerated() {
            let y = bottom + CGFloat(lines.count - 1 - index) * (lineHeight + 2)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11, weight: .medium),
                .foregroundColor: line.1.withAlphaComponent(state.offline ? 0.42 : line.1.alphaComponent),
            ]
            let lineRect = NSRect(x: statsX, y: y, width: statsWidth, height: lineHeight)
            (line.0 as NSString).draw(in: lineRect, withAttributes: attrs)
            if line.0.hasPrefix("完成未看") {
                doneStatsRect = lineRect.insetBy(dx: -4, dy: -3)
            }
        }
    }

    private func badgeColor(for agent: String) -> NSColor {
        guard !agent.isEmpty else { return .systemGray }
        let sum = agent.utf8.reduce(0) { ($0 &* 31) &+ Int($1) }
        return badgeColors[abs(sum) % badgeColors.count]
    }

    private func badgeInitial(for agent: String?, fallback: String? = nil) -> String {
        for candidate in [agent, fallback] {
            if let first = candidate?.trimmingCharacters(in: .whitespacesAndNewlines)
                .first(where: { $0.isLetter || $0.isNumber }) {
                return String(first).uppercased()
            }
        }
        return "·"
    }
}

/// 根视图：HUD 材质背景 + 事件处理（hover / 拖动 / 双击 / 右键菜单）。
private final class HUDRootView: NSView {
    weak var controller: HUDController?
    var expanded = false {
        didSet {
            needsDisplay = true
            window?.invalidateShadow()
        }
    }

    private var tracking: NSTrackingArea?

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: HUD.circleSize, height: HUD.circleSize))
        // 2026-11-16 用户反馈：圆外面有一圈白色方形底。根因是 NSVisualEffectView
        // 用 .hudWindow 材质 + behindWindow 采样桌面，浅色壁纸下整块变白。
        // 改为普通透明 NSView，圆和面板各自绘制自己的背景。
        appearance = NSAppearance(named: .darkAqua)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.cornerRadius = HUD.circleRadius
        layer?.masksToBounds = true
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    override var isOpaque: Bool { false }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = superview == nil ? convert(point, from: nil) : convert(point, from: superview)
        guard bounds.contains(local) else { return nil }

        if expanded {
            // 面板是圆角矩形：四个角之外的点穿透给下层 App。
            let r = HUD.panelCorner
            let inCornerX = local.x < r ? (r - local.x) : (local.x > bounds.width - r ? local.x - (bounds.width - r) : 0)
            let inCornerY = local.y < r ? (r - local.y) : (local.y > bounds.height - r ? local.y - (bounds.height - r) : 0)
            if inCornerX > 0, inCornerY > 0,
               hypot(inCornerX, inCornerY) > r {
                return nil
            }
        } else {
            // 收起态：命中区域必须是圆的，不能是 56×56 方块的四个角。
            let dx = local.x - bounds.midX
            let dy = local.y - bounds.midY
            if hypot(dx, dy) > bounds.width / 2 - 0.5 { return nil }
        }
        return self
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero,
                                  options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self,
                                  userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    private(set) var mouseInside = false

    override func mouseEntered(with event: NSEvent) {
        mouseInside = true
        controller?.hudMouseEntered()
    }

    override func mouseExited(with event: NSEvent) {
        mouseInside = false
        controller?.hudMouseExited()
    }

    override func mouseDown(with event: NSEvent) {
        controller?.handleMouseDown(event)
    }

    override func mouseDragged(with event: NSEvent) {
        controller?.handleMouseDragged(event)
    }

    override func mouseUp(with event: NSEvent) {
        controller?.handleMouseUp(event)
    }

    override func scrollWheel(with event: NSEvent) {
        controller?.handleScroll(event)
    }

    override func rightMouseDown(with event: NSEvent) {
        controller?.showContextMenu(with: event, in: self)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }
}

// MARK: - HUDController

private struct Expansion {
    let panel: NSRect
    let circleInPanel: NSPoint
    let growLeft: Bool
    let growUp: Bool
    let clamped: Bool
    let screenName: String
}

private final class HUDController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let options: Options
    private var window: NSWindow?
    private var rootView: HUDRootView?
    private var panelContent: PanelContentView?
    private var circleView: CircleBadgeView?

    private var state = RenderState()
    /// 非 nil 时面板展示该次运行的详情（点「完成未看」行进入）。
    private var detail: RadarDetail?
    /// 详情形态（摘要 / 事件流），与视图侧同步。
    private var detailMode: DetailMode = .summary
    /// 详情打开时刻（用于抑制紧随其后的第二次 mouseUp）。
    private var detailOpenedAt = Date.distantPast
    /// 同一个鼠标up 会被投递两次（根视图 + 内部视图），按时间戳去重。
    private var lastMouseUpTimestamp: TimeInterval = 0
    private var lastLoggedSignature = ""
    private var lastGoodURL: URL?
    private var lastResolvedDescription = ""
    private var lastResolvedURLString = ""
    /// 详情对应 run 已拿到的最大 seq：实时跟随时用它做增量拉取。
    /// 当前审批视图对应的桥内审批 id（点击批准/拒绝时用）。
    private var pendingApprovalId: String?
    /// N-10：当前审批对应的提问列表（无 options 时要逐条输入文本）。
    private var pendingQuestions: [RadarQuestion] = []
    /// 待审批项的一次性 token（桥用来确认「这次决定来自看到这条审批的人」）。
    private var pendingApprovalToken: String?

    private var detailLastSeq = 0
    /// 详情打开期间的增量轮询（只在运行中启用）。
    private var liveDetailTimer: Timer?
    /// 运行结束时补一次全量拉取（拿 finalAnswer 与完整事件），避免收尾停在半句。
    private var detailFinalReloadPending = false

    private var pollTimer: Timer?
    private var hideTimer: Timer?
    private var collapseTimer: Timer?
    /// 有「需批准」时驱动圆圈的红色脉冲。
    private var pulseTimer: Timer?
    private var pulsePhase: CGFloat = 0
    /// 指针当前是否还在 HUD 窗口里（拖动结束后判断要不要立刻收起）。
    private func rootHovered() -> Bool {
        rootView?.mouseInside ?? false
    }

    /// `window.performDrag` 是阻塞式拖拽循环，期间的 mouseExited 不能触发收起，
    /// 否则窗口会在拖拽途中被缩回旧坐标，看起来像「拖完又弹回右下角」。
    private var isDragging = false
    /// 手动实现拖动：`window.performDrag` 在无边框 + 合成事件下不可靠，
    /// 且它自己的模态循环会和「悬停收起」打架。
    private var dragStartMouse: NSPoint?
    private var dragStartOrigin: NSPoint = .zero
    private var dragMoved = false
    private var fetchInFlight = false
    private var fetchGeneration = 0

    private var isTopmost = true
    private var didCleanup = false
    private var signalSources: [DispatchSourceSignal] = []

    /// 收起态圆形左下角的屏幕坐标；展开/收起都围绕它进行。
    private var circleOrigin = NSPoint.zero
    private var isExpanded = false
    private var isAnimatingFrame = false
    private var circleInPanel = NSPoint.zero
    private var growLeft = true
    private var growUp = true

    init(options: Options) {
        self.options = options
        if let dir = options.stateDir, !dir.isEmpty {
            Paths.stateDirOverride = URL(fileURLWithPath: dir, isDirectory: true)
        }
        super.init()
    }

    // MARK: 启动

    func start() {
        createBridgeDirectory()

        guard claimSingleInstance() else {
            log("another RadarHUD instance is running, exit 0")
            exit(0)
        }

        installSignalHandlers()

        let restored = restoredCircleOrigin()
        circleOrigin = restored ?? defaultCircleOrigin()
        circleOrigin = clampedCircleOrigin(circleOrigin)

        let size = NSSize(width: HUD.circleSize, height: HUD.circleSize)
        let window = NSWindow(contentRect: NSRect(origin: circleOrigin, size: size),
                              styleMask: [.borderless],
                              backing: .buffered,
                              defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = isTopmost ? HUD.topLevel : HUD.offLevel
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.title = "DSH Task Radar"
        window.appearance = NSAppearance(named: .darkAqua)
        window.ignoresMouseEvents = false
        window.acceptsMouseMovedEvents = true

        let root = HUDRootView()
        root.controller = self
        let panel = PanelContentView(frame: root.bounds)
        panel.autoresizingMask = [.width, .height]
        panel.expanded = false
        panel.alphaValue = 0
        panel.wantsLayer = true
        let circle = CircleBadgeView()
        circle.state = state
        root.addSubview(panel)
        root.addSubview(circle)
        window.contentView = root

        self.window = window
        self.rootView = root
        self.panelContent = panel
        self.circleView = circle

        window.setFrameOrigin(circleOrigin)
        layoutContents(in: root)
        window.orderFrontRegardless()
        window.invalidateShadow()

        log("RadarHUD start pid=\(getpid()) source=\(describeSource()) interval=\(options.interval) " +
            "expandFlag=\(options.forceExpanded)")
        log("window frame=\(NSStringFromRect(window.frame)) level=\(window.level.rawValue) " +
            "collectionBehavior=\(window.collectionBehavior.rawValue) screens=\(NSScreen.screens.count) " +
            "savedOrigin=\(restored != nil ? "restored" : "default") circleSize=\(HUD.circleSize) " +
            "pidFile=\(Paths.pid.path)")

        if options.forceExpanded {
            log("force expand at startup")
            setExpanded(true, animated: false)
        }

        startPolling()
        fetchNow(reason: "startup")
    }

    func applicationWillTerminate(_ notification: Notification) {
        saveCurrentOrigin()
        cleanup()
    }

    // MARK: 单实例 / pid

    private func createBridgeDirectory() {
        do {
            try FileManager.default.createDirectory(at: Paths.bridgeDir,
                                                    withIntermediateDirectories: true)
        } catch {
            log("warn: 无法创建 \(Paths.bridgeDir.path): \(error.localizedDescription)")
        }
    }

    private func claimSingleInstance() -> Bool {
        if let existing = readPid(), isRadarProcess(existing), existing != getpid() {
            log("pid file points to live RadarHUD pid=\(existing)")
            return false
        }
        writePid()
        return true
    }

    /// pid 文件内容：`{"pid":123,"ownerPort":49409,...}`（新）或裸数字（旧版本）。
    private func readPid() -> pid_t? {
        guard let data = try? Data(contentsOf: Paths.pid),
              let text = String(data: data, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{") {
            if let json = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)) as? [String: Any],
               let pid = (json["pid"] as? NSNumber)?.int32Value {
                return pid
            }
            return nil
        }
        return pid_t(trimmed)
    }

    /// 归属端口：state-dir 的最后一段是端口；没有就用 URL 上的端口。
    private func ownerPort() -> Int? {
        if let dir = Paths.stateDirOverride, let port = Int(dir.lastPathComponent) { return port }
        if let port = lastGoodURL?.port { return port }
        if case .explicit(let url) = options.source, let port = url.port { return port }
        return nil
    }

    private func isRadarProcess(_ pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        if kill(pid, 0) != 0 { return false }
        var buffer = [CChar](repeating: 0, count: 4096)
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return false }
        let path = String(cString: buffer)
        return (path as NSString).lastPathComponent == "RadarHUD"
    }

    private func writePid() {
        do {
            // ownerPort 让宿主侧 supervisor 能校验「这个 HUD 是不是我起的」（N-14）。
            let owner = ownerPort().map(String.init) ?? "null"
            let payload = "{\"pid\":\(getpid()),\"ownerPort\":\(owner),\"dir\":\"\(Paths.bridgeDir.path)\",\"updatedAt\":\(Int(Date().timeIntervalSince1970 * 1000))}\n"
            try payload.write(to: Paths.pid, atomically: true, encoding: .utf8)
        } catch {
            log("warn: 无法写入 pid 文件: \(error.localizedDescription)")
        }
    }

    private func removePidIfOwned() {
        if let pid = readPid(), pid == getpid() {
            try? FileManager.default.removeItem(at: Paths.pid)
            log("pid file removed")
        }
    }

    // MARK: 信号

    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                self?.shutdown(reason: "signal \(sig)")
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func shutdown(reason: String) {
        log("shutdown: \(reason)")
        saveCurrentOrigin()
        cleanup()
        if let window {
            window.orderOut(nil)
        }
        NSApp.terminate(nil)
        // 兜底：NSApp.terminate 在极端情况下可能不走 applicationWillTerminate。
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) }
    }

    private func cleanup() {
        guard !didCleanup else { return }
        didCleanup = true
        pollTimer?.invalidate()
        pollTimer = nil
        hideTimer?.invalidate()
        hideTimer = nil
        collapseTimer?.invalidate()
        collapseTimer = nil
        pulseTimer?.invalidate()
        pulseTimer = nil
        removePidIfOwned()
        fflush(stdout)
    }

    // MARK: 位置持久化

    private func restoredCircleOrigin() -> NSPoint? {
        guard let data = try? Data(contentsOf: Paths.window),
              let saved = try? JSONDecoder().decode(SavedOrigin.self, from: data) else { return nil }

        guard (saved.version ?? 0) >= 2 else {
            log("legacy hud-window.json v\(saved.version ?? 0) 坐标语义已变化，使用默认右下角")
            return nil
        }

        let point = NSPoint(x: saved.x, y: saved.y)
        let rect = NSRect(origin: point, size: NSSize(width: HUD.circleSize, height: HUD.circleSize))
        guard screen(containing: rect) != nil else {
            log("saved origin \(NSStringFromPoint(point)) 不在任何可见屏幕内，使用默认位置")
            return nil
        }
        return point
    }

    private func defaultCircleOrigin() -> NSPoint {
        // 用主显示器（菜单栏所在屏）而不是 NSScreen.main（跟随焦点窗口），
        // 否则默认位置会跑到副屏去。
        let screen = NSScreen.screens.first ?? NSScreen.main
        guard let visible = screen?.visibleFrame else {
            return NSPoint(x: 24, y: 24)
        }
        // 默认右下角，避免与 DSH 窗口右上角重叠；展开时向左/向上生长。
        return NSPoint(x: visible.maxX - HUD.circleSize - 24,
                       y: visible.minY + 24)
    }

    private func clampedCircleOrigin(_ point: NSPoint) -> NSPoint {
        let rect = NSRect(origin: point, size: NSSize(width: HUD.circleSize, height: HUD.circleSize))
        guard let screen = screen(containing: rect) else { return defaultCircleOrigin() }
        let visible = screen.visibleFrame
        return NSPoint(x: min(max(point.x, visible.minX), visible.maxX - HUD.circleSize),
                       y: min(max(point.y, visible.minY), visible.maxY - HUD.circleSize))
    }

    private func screen(containing rect: NSRect) -> NSScreen? {
        var best: (NSScreen, CGFloat)?
        for screen in NSScreen.screens {
            let inter = screen.frame.intersection(rect)
            let area = inter.isNull ? 0 : inter.width * inter.height
            if area > (best?.1 ?? 0) {
                best = (screen, area)
            }
        }
        if let best, best.1 > 0 { return best.0 }
        return nil
    }

    private func currentCircleRect() -> NSRect {
        let origin: NSPoint
        if isExpanded, let window {
            origin = NSPoint(x: window.frame.minX + circleInPanel.x,
                             y: window.frame.minY + circleInPanel.y)
        } else if let window {
            origin = window.frame.origin
        } else {
            origin = circleOrigin
        }
        return NSRect(origin: origin, size: NSSize(width: HUD.circleSize, height: HUD.circleSize))
    }

    private func saveCurrentOrigin() {
        guard let window else { return }
        let origin: NSPoint
        if isExpanded {
            origin = NSPoint(x: window.frame.minX + circleInPanel.x,
                             y: window.frame.minY + circleInPanel.y)
        } else {
            origin = window.frame.origin
        }
        circleOrigin = origin
        saveOrigin(origin)
    }

    private func saveOrigin(_ origin: NSPoint) {
        let saved = SavedOrigin(x: Double(origin.x), y: Double(origin.y), version: 2)
        guard let data = try? JSONEncoder().encode(saved) else { return }
        do {
            try data.write(to: Paths.window, options: .atomic)
        } catch {
            log("warn: 无法保存窗口位置: \(error.localizedDescription)")
        }
    }

    // MARK: 轮询 / 数据源

    private func startPolling() {
        pollTimer?.invalidate()
        let timer = Timer(timeInterval: options.interval, repeats: true) { [weak self] _ in
            self?.fetchNow(reason: "timer")
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    private func describeSource() -> String {
        switch options.source {
        case .explicit(let url): return "url=\(url.absoluteString)"
        case .auto: return "url=auto(\(Paths.radarURL.path))"
        case .mock(let path): return "mock=\(path)"
        }
    }

    /// auto 模式：每轮重读 radar-url.json；失败回退 lastGoodURL。
    private func resolveURL() -> (URL?, String) {
        switch options.source {
        case .explicit(let url):
            lastGoodURL = url
            return (url, "explicit")
        case .mock:
            return (nil, "mock")
        case .auto:
            if let url = readRadarURLFile() {
                lastGoodURL = url
                return (url, "file")
            }
            if let lastGoodURL {
                return (lastGoodURL, "last-known")
            }
            return (nil, "no-url")
        }
    }

    private func readRadarURLFile() -> URL? {
        guard let data = try? Data(contentsOf: Paths.radarURL),
              let file = try? JSONDecoder().decode(RadarURLFile.self, from: data),
              let raw = file.url,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil else { return nil }
        // 端口 0（或缺失）说明宿主还没绑定端口：直接采用会让胶囊在下一个轮询里
        // 连到 127.0.0.1:0 并转 offline（实测 08:49:24 / 08:50:46 两次）。
        // 这时保留上一次可用 URL，等宿主把真实端口写进文件。
        if let port = url.port, port <= 0 {
            log("url ignored port=\(port) file=\(url.absoluteString)")
            return nil
        }
        return url
    }

    private func fetchNow(reason: String) {
        guard !fetchInFlight else { return }
        fetchInFlight = true
        fetchGeneration += 1
        let generation = fetchGeneration

        switch options.source {
        case .mock(let path):
            loadMock(path: path, generation: generation)
        case .explicit, .auto:
            let (url, source) = resolveURL()
            guard let url else {
                finishOffline(reason: "auto: radar-url.json 不存在且没有历史 URL", generation: generation)
                return
            }
            let resolutionKey = "\(url.absoluteString)|\(source)"
            if resolutionKey != lastResolvedURLString {
                lastResolvedURLString = resolutionKey
                lastResolvedDescription = source
                log("url resolved \(url.absoluteString) source=\(source) reason=\(reason)")
            }
            loadRemote(url: url, generation: generation)
        }
    }

    private func loadRemote(url: URL, generation: Int) {
        var request = URLRequest(url: url,
                                 cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: 5)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self, generation == self.fetchGeneration else { return }
                if let error {
                    self.finishOffline(reason: "network: \(error.localizedDescription)", generation: generation)
                    return
                }
                if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                    self.finishOffline(reason: "http \(http.statusCode)", generation: generation)
                    return
                }
                guard let data else {
                    self.finishOffline(reason: "empty body", generation: generation)
                    return
                }
                self.apply(data: data, origin: "remote", generation: generation)
            }
        }
        task.resume()
    }

    private func loadMock(path: String, generation: Int) {
        let expanded = (path as NSString).expandingTildeInPath
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result: Result<Data, Error>
            do {
                result = .success(try Data(contentsOf: URL(fileURLWithPath: expanded)))
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async {
                guard let self, generation == self.fetchGeneration else { return }
                switch result {
                case .failure(let error):
                    self.finishOffline(reason: "mock read: \(error.localizedDescription)", generation: generation)
                case .success(let data):
                    self.apply(data: data, origin: "mock", generation: generation)
                }
            }
        }
    }

    private func apply(data: Data, origin: String, generation: Int) {
        guard generation == fetchGeneration else { return }
        fetchInFlight = false
        do {
            let payload = try JSONDecoder().decode(RadarPayload.self, from: data)
            if payload.ok == false {
                finishOffline(reason: "server returned ok=false", generation: generation, alreadyFetched: true)
                return
            }
            let counts = payload.counts ?? RadarCounts()
            state.pending = counts.pending
            state.running = counts.running
            state.approvals = counts.approvals
            state.questions = counts.questions
            state.failed = counts.failed
            state.doneUnread = counts.doneUnread
            state.doneUnreadIds = payload.doneUnreadIds
            state.autoConfirmed = counts.autoConfirmed
            state.items = payload.items
            clientHalf = payload.clientHalf
            state.offline = false
            updateUI(origin: origin)
        } catch {
            finishOffline(reason: "parse: \(error.localizedDescription)", generation: generation, alreadyFetched: true)
        }
    }

    /// 离线：保留最后一次成功取到的数字/列表，只把数字变暗并显示「离线」，继续轮询。
    private func finishOffline(reason: String, generation: Int, alreadyFetched: Bool = false) {
        guard generation == fetchGeneration else { return }
        if !alreadyFetched { fetchInFlight = false }
        let wasOffline = state.offline
        state.offline = true
        if !wasOffline {
            log("offline: \(reason)")
        }
        updateUI(origin: "offline")
    }

    // MARK: 渲染

    private func updateUI(origin: String) {
        guard let window, let panelContent, let circleView else { return }
        let idle = state.idle
        window.alphaValue = idle ? HUD.idleAlpha : 1.0

        circleView.state = state
        syncPulseTimer()
        pruneNotifications()
        notifyQuestions()
        notifyFinished()
        notifyApproval()
        notifyReview()
        notifyClientHalf()
        panelContent.state = state
        panelContent.detail = detail

        if isExpanded, !isAnimatingFrame {
            refreshExpandedGeometry(animated: true)
        }

        window.invalidateShadow()
        panelContent.needsDisplay = true
        circleView.needsDisplay = true

        if state.signature != lastLoggedSignature {
            lastLoggedSignature = state.signature
            log("render pending=\(state.pending) running=\(state.running) " +
                "approvals=\(state.approvals) questions=\(state.questions) " +
                "failed=\(state.failed) doneUnread=\(state.doneUnread) " +
                "sessions=\(state.runningSessions.count) " +
                "mode=\(state.offline ? "offline" : (idle ? "idle" : "active")) " +
                "alpha=\(String(format: "%.2f", window.alphaValue)) " +
                "expanded=\(isExpanded ? 1 : 0) origin=\(origin)")
        }
    }

    // MARK: 展开 / 收起

    private func panelHeight() -> CGFloat {
        if let detail {
            if detailMode == .raw {
                return HUD.bandHeight + HUD.contentPadding * 2 + HUD.headerHeight +
                    CGFloat(HUD.rawVisibleRows) * 13 + 22
            }
            if detailMode == .events {
                // band(圆) + 上下 padding + 头部 + 12 行事件 + 底部按钮
                return HUD.bandHeight + HUD.contentPadding * 2 + HUD.headerHeight +
                    CGFloat(HUD.eventVisibleRows) * 15 + 22
            }
            if detailMode == .children {
                // band + padding + 头部 + 最多 6 行子会话 + 底部提示
                let rows = min(max(1, detail.children.count), 6)
                return HUD.bandHeight + HUD.contentPadding * 2 + HUD.headerHeight +
                    CGFloat(rows) * HUD.rowHeight + 22
            }
            if detailMode == .approval {
                // band(圆) + 上下 padding + 头部 + 标题/元信息/分隔 + 命令正文 + 底部按钮
                return HUD.bandHeight + HUD.contentPadding * 2 + HUD.headerHeight + 60 +
                    CGFloat(max(1, detail.bodyLines)) * 15 + 14
            }
            // band(圆) + 上下 padding + 头部 + 标题/元信息/分隔 + 正文 + 底部按钮
            return HUD.bandHeight + HUD.contentPadding * 2 + HUD.headerHeight + 64 +
                CGFloat(detail.bodyLines) * 15 +
                CGFloat(min(3, detail.progressLines.count)) * 13
        }
        let count = state.panelRowCount
        let rows = min(count, HUD.maxRows)
        let rowBlock = rows == 0 ? HUD.emptyRowHeight : CGFloat(rows) * HUD.rowHeight
        let overflow = count > HUD.maxRows ? HUD.overflowHeight : 0
        return HUD.bandHeight + HUD.contentPadding + HUD.headerHeight +
            rowBlock + overflow + HUD.contentPadding
    }

    /// 以圆形原来的屏幕位置为锚点，向远离屏幕边缘的方向生长；越界时夹回屏幕。
    private func expansion(for circle: NSRect) -> Expansion {
        let screen = panelScreen(for: circle)
        let visible = screen.visibleFrame
        let margin = HUD.edgeMargin
        let limit = visible.insetBy(dx: margin, dy: margin)

        let maxWidth = max(HUD.circleSize, limit.width)
        let width = min(HUD.panelWidth, maxWidth)
        let maxHeight = max(HUD.circleSize, limit.height)
        let height = min(panelHeight(), maxHeight)

        var wantLeft = circle.midX >= visible.midX
        var wantUp = circle.midY <= visible.midY

        let needX = max(0, width - HUD.circleSize - margin)
        let needY = max(0, height - HUD.circleSize - margin)
        let spaceLeft = circle.minX - limit.minX
        let spaceRight = limit.maxX - circle.maxX
        let spaceUp = limit.maxY - circle.maxY
        let spaceDown = circle.minY - limit.minY

        if wantLeft && spaceLeft < needX && spaceRight >= needX { wantLeft = false }
        if !wantLeft && spaceRight < needX && spaceLeft >= needX { wantLeft = true }
        if wantUp && spaceUp < needY && spaceDown >= needY { wantUp = false }
        if !wantUp && spaceDown < needY && spaceUp >= needY { wantUp = true }

        let inPanel = NSPoint(
            x: wantLeft ? width - margin - HUD.circleSize : margin,
            y: wantUp ? margin : height - margin - HUD.circleSize
        )
        var panel = NSRect(x: circle.minX - inPanel.x,
                           y: circle.minY - inPanel.y,
                           width: width,
                           height: height)

        let original = panel
        panel.origin.x = min(max(panel.minX, limit.minX), limit.maxX - panel.width)
        panel.origin.y = min(max(panel.minY, limit.minY), limit.maxY - panel.height)
        let clamped = abs(original.minX - panel.minX) > 0.5 || abs(original.minY - panel.minY) > 0.5

        return Expansion(panel: panel,
                         circleInPanel: inPanel,
                         growLeft: wantLeft,
                         growUp: wantUp,
                         clamped: clamped,
                         screenName: screen.localizedName)
    }

    private func layoutContents(in root: HUDRootView) {
        guard let panelContent, let circleView else { return }
        if isAnimatingFrame { return }
        panelContent.frame = root.bounds
        if isExpanded {
            circleView.frame = NSRect(x: circleInPanel.x, y: circleInPanel.y,
                                      width: HUD.circleSize, height: HUD.circleSize)
            panelContent.expanded = true
            panelContent.growLeft = growLeft
            panelContent.growUp = growUp
            panelContent.alphaValue = 1
            circleView.alphaValue = 0
        } else {
            circleView.frame = NSRect(x: 0, y: 0,
                                      width: HUD.circleSize, height: HUD.circleSize)
            panelContent.expanded = false
            panelContent.alphaValue = 0
            circleView.alphaValue = 1
        }
        root.expanded = isExpanded
        root.layer?.cornerRadius = isExpanded ? HUD.panelCorner : HUD.circleRadius
        panelContent.needsDisplay = true
        circleView.needsDisplay = true
    }

    private func logExpansion(_ action: String) {
        guard let window else { return }
        log("\(action) panel=\(NSStringFromRect(window.frame)) " +
            "circle=\(NSStringFromRect(currentCircleRect())) " +
            "growLeft=\(growLeft) growUp=\(growUp) sessions=\(state.runningSessions.count) " +
            "screen=\(screen(containing: currentCircleRect())?.localizedName ?? "?")")
        // N-06：面板一换尺寸，横幅列要重新让位（展开→横幅下移，收起→回到顶部）。
        if !banners.isEmpty { layoutBanners(animate: true) }
    }

    private func setExpanded(_ expand: Bool, animated: Bool) {
        guard let window, let rootView, let panelContent, let circleView else { return }
        guard expand != isExpanded else { return }

        if expand {
            let geo = expansion(for: NSRect(origin: circleOrigin,
                                           size: NSSize(width: HUD.circleSize, height: HUD.circleSize)))
            isExpanded = true
            growLeft = geo.growLeft
            growUp = geo.growUp
            circleInPanel = geo.circleInPanel
            rootView.expanded = true
            panelContent.expanded = true
            panelContent.growLeft = growLeft
            panelContent.growUp = growUp
            panelContent.state = state
        panelContent.detail = detail
            panelContent.needsDisplay = true

            if geo.clamped {
                log("warn: 展开面板超出屏幕，已夹回可见区域")
            }

            let targetPanel = geo.panel
            let targetCircle = NSRect(x: circleInPanel.x, y: circleInPanel.y,
                                      width: HUD.circleSize, height: HUD.circleSize)

            if animated {
                isAnimatingFrame = true
                rootView.layer?.cornerRadius = HUD.panelCorner
                panelContent.alphaValue = 0
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = HUD.animationDuration
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                    window.animator().setFrame(targetPanel, display: true)
                    circleView.animator().frame = targetCircle
                    panelContent.animator().alphaValue = 1
                }, completionHandler: { [weak self] in
                    guard let self else { return }
                    self.isAnimatingFrame = false
                    window.setFrame(targetPanel, display: true)
                    self.layoutContents(in: rootView)
                    self.logExpansion("expand")
                })
            } else {
                window.setFrame(targetPanel, display: true)
                rootView.layer?.cornerRadius = HUD.panelCorner
                layoutContents(in: rootView)
                logExpansion("expand")
            }
        } else {
            isExpanded = false
            rootView.expanded = false
            panelContent.expanded = false
            let target = NSRect(origin: circleOrigin,
                                size: NSSize(width: HUD.circleSize, height: HUD.circleSize))
            if animated {
                isAnimatingFrame = true
                rootView.layer?.cornerRadius = HUD.circleRadius
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = HUD.animationDuration
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                    window.animator().setFrame(target, display: true)
                    circleView.animator().frame = NSRect(origin: .zero,
                                                         size: NSSize(width: HUD.circleSize,
                                                                      height: HUD.circleSize))
                    panelContent.animator().alphaValue = 0
                }, completionHandler: { [weak self] in
                    guard let self else { return }
                    self.isAnimatingFrame = false
                    window.setFrame(target, display: true)
                    self.layoutContents(in: rootView)
                    self.logExpansion("collapse")
                })
            } else {
                window.setFrame(target, display: true)
                rootView.layer?.cornerRadius = HUD.circleRadius
                layoutContents(in: rootView)
                logExpansion("collapse")
            }
        }
    }

    /// 数据变化后（展开态）按新的会话条数调整面板高度；圆形像素位置保持不动。
    private func refreshExpandedGeometry(animated: Bool) {
        guard isExpanded, !isAnimatingFrame, let window, let rootView,
              let panelContent, let circleView else { return }

        let geo = expansion(for: NSRect(origin: circleOrigin,
                                       size: NSSize(width: HUD.circleSize, height: HUD.circleSize)))
        growLeft = geo.growLeft
        growUp = geo.growUp
        circleInPanel = geo.circleInPanel
        panelContent.growLeft = growLeft
        panelContent.growUp = growUp
        panelContent.needsDisplay = true

        guard abs(window.frame.width - geo.panel.width) > 0.5 ||
                abs(window.frame.height - geo.panel.height) > 0.5 ||
                abs(window.frame.minX - geo.panel.minX) > 0.5 ||
                abs(window.frame.minY - geo.panel.minY) > 0.5 else { return }

        let targetPanel = geo.panel
        let targetCircle = NSRect(x: circleInPanel.x, y: circleInPanel.y,
                                  width: HUD.circleSize, height: HUD.circleSize)
        if animated {
            isAnimatingFrame = true
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = HUD.animationDuration
                ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                window.animator().setFrame(targetPanel, display: true)
                circleView.animator().frame = targetCircle
            }, completionHandler: { [weak self] in
                guard let self else { return }
                self.isAnimatingFrame = false
                window.setFrame(targetPanel, display: true)
                self.layoutContents(in: rootView)
                self.logExpansion("expand-resize")
            })
        } else {
            window.setFrame(targetPanel, display: true)
            layoutContents(in: rootView)
            logExpansion("expand-resize")
        }
    }

    // MARK: 交互

    /// 仅在「有需批准」时跑 20fps 的脉冲定时器，其余时间不额外耗电。
    private var notifiedDone: Set<String> = []
    private var notifiedApproval: Set<String> = []
    private var notifiedQuestion: Set<String> = []
    private var notifiedReview: Set<String> = []
    private var notifiedFailed: Set<String> = []

    /// 通知去重集合必须跟着「当前仍然存在的行」收缩，否则同一个 id 只会提醒
    /// 一次就永远静默：WorkBuddy 的合成 id 恒为 workbuddy、同一条会话第二次
    /// 跑完也不再横幅（R-07）。刷新时用当前 feed 重建集合。
    private func pruneNotifications() {
        let approvalIds = Set(state.approvalItems.compactMap { $0.id })
        let questionIds = Set(state.questionItems.compactMap { $0.id })
        let doneIds = Set(state.items.filter { $0.isDoneUnreadRun }.compactMap { doneKey($0) })
        let reviewIds = Set(state.reviewRuns.compactMap { $0.id })
        let failedIds = Set(state.failedRuns.compactMap { $0.id })
        notifiedApproval.formIntersection(approvalIds)
        notifiedQuestion.formIntersection(questionIds)
        notifiedDone.formIntersection(doneIds)
        notifiedReview.formIntersection(reviewIds)
        notifiedFailed.formIntersection(failedIds)
    }

    /// agent 在向你提问：必须有一条可读的横幅，而不是当成普通批准（R-05）。
    private func notifyQuestions() {
        for item in state.questionItems {
            guard let id = item.id, !notifiedQuestion.contains(id) else { continue }
            notifiedQuestion.insert(id)
            // 点横幅 = 直接打开这条提问的选项面板（否则用户只知道「有事」，不知道点哪）。
            showBanner(title: "等你回答", body: item.title ?? "agent 有问题要问你") { [weak self] in
                self?.openApproval((id: item.id ?? "", approvalId: item.approvalId ?? item.id ?? ""))
            }
            log("banner question \(shortId(id)) \(item.title ?? "")")
        }
    }

    /// 日志里用短 id：feed 的 id 带 `approval:` / `run:` 前缀，直接 prefix(8)
    /// 只会打出 `approval` 这种没信息量的串。
    private func shortId(_ id: String) -> String {
        let bare = id.split(separator: ":", maxSplits: 1).last.map(String.init) ?? id
        return String(bare.prefix(8))
    }

    /// 新完成的任务发一条 macOS 通知（同一任务只提醒一次）。
    private func notifyApproval() {
        let fresh = state.approvalItems.filter { item in
            guard let id = item.id else { return false }
            return !notifiedApproval.contains(id)
        }
        for item in fresh {
            guard let id = item.id else { continue }
            notifiedApproval.insert(id)
            let count = state.approvalItems.count
            let title = count > 1 ? "等你批准（\(count) 个）" : "等你批准"
            showBanner(title: title, body: item.title ?? "有一个任务等你批准") { [weak self] in
                self?.openApproval((id: item.id ?? "", approvalId: item.approvalId ?? item.id ?? ""))
            }
            log("banner approval \(shortId(id)) \(item.title ?? "")")
        }
    }

    /// 完成提醒：折叠成一条队列卡（2.21）。新完成不断并进同一张卡，标题是
    /// 「N 个任务完成」+ 最新一条摘要；点卡顶 = 确认这批并让下方上移。
    /// 去重键带 updatedAt —— 同一 session 第二次完成是一个新事件，必须重新提醒。
    private var pendingDoneIds: [String] = []
    private var pendingDoneCount = 0
    private var doneBanner: NSWindow?

    private func notifyFinished() {
        let done = state.items.filter { $0.isDoneUnreadRun && ($0.kind == "run" || $0.kind == "session") }
        let fresh = done.filter { item in
            guard let key = doneKey(item) else { return false }
            return !notifiedDone.contains(key)
        }
        guard !fresh.isEmpty else { return }
        for item in fresh { if let key = doneKey(item) { notifiedDone.insert(key) } }
        // N-07：标题里的 N 与 feed 的 counts.doneUnread **同源同值**（同一个时刻、同一个字段），
        // 而不是「本次累计提醒了几条」——后者会比未读数大，用户看到「5 个任务完成」但面板只有 2 行。
        // 点击确认时按同一份 id 集合清，保证「标题 N = 点一下清掉的未读 = 面板消失的行」。
        // 同一集合派生：优先用宿主给的完整未读 id 清单（不受 12 行截断影响），
        // 宿主没给时退回可见行；count 一律等于 ids 的数量，保证
        // 「标题 N = ids.size = feed.doneUnread」，不再出现「25 个」但只清 12 条。
        let visibleIds = done.compactMap { $0.id }
        let unreadIds = state.doneUnreadIds.isEmpty ? visibleIds : state.doneUnreadIds
        pendingDoneIds = unreadIds
        pendingDoneCount = unreadIds.count
        if state.doneUnread != unreadIds.count {
            log("banner done mismatch feed=\(state.doneUnread) ids=\(unreadIds.count) visible=\(visibleIds.count)")
        }
        let newest = fresh.max { ($0.updatedAt ?? 0) < ($1.updatedAt ?? 0) } ?? fresh[0]
        let body = newest.title ?? "任务已完成"
        // 旧卡先撤掉，避免「一张单条卡 + 一张折叠卡」同时挂着互相覆盖。
        if let old = doneBanner { dismissBanner(old, reason: "merge"); doneBanner = nil }
        let count = pendingDoneCount
        let title = count > 1 ? "\(count) 个任务完成" : (newest.kind == "session" ? "会话完成" : (newest.agent ?? "agent").uppercased() + " 任务完成")
        let ids = pendingDoneIds
        doneBanner = showBanner(title: title, body: body) { [weak self] in
            guard let self else { return }
            // 点折叠卡 = 确认这批未读 + 直接打开最新那条的结果页（N-06：点击必须有可见结果，
            // 而不是只让卡片消失）。markSeen 与 openDetail 用的是同一批 id。
            self.markSeen(ids: ids)
            self.pendingDoneIds = []
            self.pendingDoneCount = 0
            self.doneBanner = nil
            if let newestId = newest.id {
                log("banner done open newest=\(self.shortId(newestId))")
                self.openDetail(newestId)
            }
        }
        // 口径证据：title 里的 count、点击清掉的 ids、feed 的 doneUnread 三者同值。
        log("banner done queue count=\(count) doneUnread=\(state.doneUnread) ids=\(unreadIds.count) newest=\(shortId(newest.id ?? "-")) \(body)")
    }

    /// 事件唯一键：run 一次跑完是一个事件（run id 本身唯一）；会话要区分轮次，
    /// 用 finishedAt 而不是 updatedAt —— updatedAt 会随后续事件前移，同一轮会被
    /// 误判成新事件反复提醒（实测两个 run 折叠成「3 个任务完成」）。
    private func doneKey(_ item: RadarItem) -> String? {
        guard let id = item.id else { return nil }
        if item.kind == "session" {
            // finishedAt 是秒，updatedAt 是毫秒：统一成毫秒再取整，避免同一轮两种精度。
            let round = item.finishedAt.map { Int($0 * 1000) } ?? Int(item.updatedAt ?? 0)
            return "\(id)#\(round)"
        }
        return "\(id)#run"
    }

    /// 失败/被闸门拦下的任务：以前完全没有主动提示（R-09/R-13）。
    private func notifyReview() {
        for item in state.failedRuns {
            guard let id = item.id, !notifiedFailed.contains(id) else { continue }
            notifiedFailed.insert(id)
            let body = (item.finalAnswer?.isEmpty == false ? item.finalAnswer! : item.title) ?? "任务失败了"
            // N-08：插值必须整体加括号，否则 Swift 会把 `.uppercased()` 当字面量打进标题
            // （实测横幅出现过 `codex.uppercased() 任务失败`）。
            let who = (item.agent ?? "agent").uppercased()
            // 失败卡也可点：点开就是这次 run 的日志/结果（否则用户只能自己去找）。
            let failedId = id
            showBanner(title: "\(who) 任务失败", body: body) { [weak self] in
                self?.openDetail(failedId)
            }
            log("banner failed \(id.prefix(8))")
        }
        for item in state.reviewRuns where item.status == "blocked" || item.status == "rework" {
            guard let id = item.id, !notifiedReview.contains(id) else { continue }
            notifiedReview.insert(id)
            let title = item.status == "blocked" ? "需要你决定" : "任务被退回"
            let body = item.title ?? (item.status == "blocked" ? "有任务在等你决定" : "有任务需要返工")
            showBanner(title: title, body: body)
            log("banner review \(shortId(id)) status=\(item.status ?? "-")")
        }
    }

    /// 通知队列：index 0 是屏幕最上面那一条（最新），点击确认后下方的整体上移一格。
    private var banners: [NSWindow] = []
    private var bannerTitles: [ObjectIdentifier: String] = [:]
    private let bannerWidth: CGFloat = 320
    private let bannerHeight: CGFloat = 88
    private let bannerGap: CGFloat = 8

    /// N-09：横幅要出现在「用户正在看的那块屏」。
    /// 旧实现写死 `NSScreen.screens.first`，多显示器时可能落到另一块屏（甚至不在主屏坐标系里），
    /// 用户会以为通知丢了。优先级：鼠标所在屏 → 胶囊所在屏 → NSScreen.main → 第一块。
    /// 选屏的单一入口（N-09 + t21 第 3 条）。
    /// 横幅与面板共用同一条优先级链「鼠标所在屏 / 胶囊所在屏 → 主屏 → 第一块屏」，
    /// 只是谁排第一不同：横幅优先人正在看的屏，面板优先胶囊贴着的屏（面板必须挨着胶囊）。
    /// 两条链写在一处，避免两边各自演化出不一致的兜底顺序。
    private func chooseScreen(preferMouse: Bool) -> (screen: NSScreen?, source: String) {
        let mouse = NSEvent.mouseLocation
        let hovered = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })
        let circle = screen(containing: currentCircleRect())
        let ordered: [(NSScreen?, String)] = preferMouse
            ? [(hovered, "mouse"), (circle, "circle")]
            : [(circle, "circle"), (hovered, "mouse")]
        for (candidate, source) in ordered {
            if let candidate = candidate { return (candidate, source) }
        }
        if let main = NSScreen.main { return (main, "main") }
        return (NSScreen.screens.first, "first")
    }

    /// N-09：横幅跟着「人正在看的屏」走，而不是永远第一块屏。
    /// 优先级：鼠标所在屏 → 圆形胶囊所在屏 → 主屏 → 第一块屏。
    private func bannerScreen() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        let count = NSScreen.screens.count
        let picked = chooseScreen(preferMouse: true)
        log("banner screen source=\(picked.source) name=\(picked.screen?.localizedName ?? "?") screens=\(count) mouse=(\(Int(mouse.x)),\(Int(mouse.y)))")
        return picked.screen
    }

    /// 面板展开用同一套选屏链，但优先「胶囊所在屏」（t21 第 3 条允许的口径：
    /// 与横幅同一逻辑 / 或胶囊所在屏），这样鼠标临时滑到副屏也不会把面板拽离胶囊。
    private func panelScreen(for circle: NSRect) -> NSScreen {
        let count = NSScreen.screens.count
        let anchor = screen(containing: circle)
        let picked: (screen: NSScreen?, source: String)
        if let anchor = anchor {
            picked = (anchor, "circle")
        } else {
            picked = chooseScreen(preferMouse: true)
        }
        log("panel screen source=\(picked.source) name=\(picked.screen?.localizedName ?? "?") screens=\(count) circle=(\(Int(circle.minX)),\(Int(circle.minY)))")
        return picked.screen ?? NSScreen.main ?? NSScreen.screens[0]
    }

    /// 横幅的顶部基线：面板展开且与横幅列水平重叠时，整列横幅让到面板下方，
    /// 这样「点横幅」永远不会先命中面板空白（N-06 的第二半）。
    /// 测试钩子：把可用高度压到 N 点（`DSH_TASK_RADAR_BANNER_ROOM=200`），
    /// 用来在正常屏幕上复现「高度不够 → 折叠」的分支，避免只能靠肉眼在矮屏上验证。
    private func bannerUsableFrame(_ screen: NSScreen) -> NSRect {
        var frame = screen.visibleFrame
        if let raw = ProcessInfo.processInfo.environment["DSH_TASK_RADAR_BANNER_ROOM"], let room = Double(raw), room > 40 {
            frame.size.height = min(frame.height, CGFloat(room))
            frame.origin.y = screen.visibleFrame.maxY - frame.size.height
        }
        return frame
    }

    private func bannerTopY(on screen: NSScreen) -> CGFloat {
        let usable = bannerUsableFrame(screen)
        var top = usable.maxY - 4
        if isExpanded, let window, window.isVisible {
            let panel = window.frame
            let column = NSRect(x: usable.maxX - bannerWidth - 18,
                                y: usable.minY,
                                width: bannerWidth, height: usable.height)
            if panel.intersects(column) {
                let avoided = min(top, panel.minY - bannerGap)
                // 面板贴到了屏幕下沿时，「让到面板上方」会连一张卡都放不下：这时宁可
                // 与面板重叠一张也不要把通知藏掉（卡片仍在可见区内，y >= 8）。
                if avoided - (bannerHeight + bannerGap) >= usable.minY + 8 {
                    top = avoided
                    log("banner avoid panel panel=\(NSStringFromRect(panel)) top=\(Int(top))")
                } else {
                    log("banner avoid panel skipped (no room above) panel=\(NSStringFromRect(panel)) top=\(Int(top))")
                }
            }
        }
        let lowest = usable.minY + 8
        if top < lowest {
            log("banner clamp top=\(Int(top)) -> \(Int(lowest)) (面板占满了右侧)")
            return lowest
        }
        return top
    }

    /// 队列按「最新在最上面」重排：所有卡片共用同一套槽位计算，绝不重叠。
    private func layoutBanners(animate: Bool) {
        guard let screen = bannerScreen() else { return }
        let baseTop = bannerTopY(on: screen)
        // 可用高度不足时不再把卡片排到屏幕外：只摆得下的条数可见，剩下的折叠成
        // 「另有 N 条」写在最后一张卡上（t17 的 finding：clamp 只抬了 top，
        // slot 1/2 依然算到可见区以下）。
        let usable = bannerUsableFrame(screen)
        let lowest = usable.minY + 8
        // 第 i 张卡的 y = baseTop - (i+1)*(h+gap)，要 >= lowest 才算放得下。
        let fit = max(1, Int(((baseTop - lowest) / (bannerHeight + bannerGap)).rounded(.down)))
        var visible = 0
        var hidden = 0
        var placed: [String] = []
        for (slot, window) in banners.enumerated() {
            let y = baseTop - CGFloat(slot + 1) * (bannerHeight + bannerGap)
            guard slot < fit, y >= lowest else {
                window.orderOut(nil)
                hidden += 1
                continue
            }
            let frame = NSRect(x: screen.visibleFrame.maxX - bannerWidth - 18,
                               y: y,
                               width: bannerWidth, height: bannerHeight)
            if animate {
                window.setFrame(frame, display: true, animate: true)
            } else {
                window.setFrame(frame, display: true)
            }
            (window.contentView as? BannerView)?.setFoldedCount(0)
            placed.append("\(slot):y=\(Int(y))")
            visible += 1
        }
        if hidden > 0 {
            if let lastVisible = banners.prefix(visible).last,
               let view = lastVisible.contentView as? BannerView {
                view.setFoldedCount(hidden)
            }
            log("banner fold visible=\(visible) hidden=\(hidden) fit=\(fit) " +
                "baseTop=\(Int(baseTop)) lowest=\(Int(lowest)) (可用高度不足)")
        }
        // 布局证据：只记录真正摆上去的卡；被折叠的不占坐标（绝不出现屏幕外的 y）。
        let slots = placed.joined(separator: " ")
        log("banner layout n=\(banners.count) screen=\(screen.localizedName) frame=\(NSStringFromRect(screen.visibleFrame)) " +
            "baseTop=\(Int(baseTop)) panel=\(isExpanded ? NSStringFromRect(window?.frame ?? .zero) : "collapsed") \(slots)")
    }

    /// 应用内横幅：不依赖系统通知权限，直接画在屏幕右上角。
    /// 可点确认的卡（onClick != nil）常驻到被点掉/60s；纯提示卡 6s 自动消失。
    @discardableResult
    private func showBanner(title: String, body: String, onClick: (() -> Void)? = nil) -> NSWindow? {
        guard let screen = bannerScreen() else { return nil }
        let width = bannerWidth
        let height = bannerHeight
        // 队列满 3 条：挤掉最旧的一条（队尾），并在日志里留下被挤掉的标题，不静默丢通知。
        if banners.count >= 3, let oldest = banners.last {
            log("banner evict oldest (3 already visible) \(bannerTitles[ObjectIdentifier(oldest)] ?? "-")")
            banners.removeLast()
            oldest.orderOut(nil)
        }
        let frame = NSRect(x: screen.visibleFrame.maxX - width - 18, y: 0, width: width, height: height)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = .statusBar
        window.hasShadow = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.ignoresMouseEvents = false
        let view = BannerView(frame: NSRect(x: 0, y: 0, width: width, height: height), title: title, body: body)
        view.onClick = { [weak self, weak window] in
            guard let window else { return }
            // 点一下 = 确认：从队列移除并让下面的整体上移（这里靠重排实现）。
            self?.dismissBanner(window)
            onClick?()
        }
        window.contentView = view
        window.alphaValue = 0
        window.orderFrontRegardless()
        // 新通知插到队首（最上面），旧的整体下移一格。
        banners.insert(window, at: 0)
        bannerTitles[ObjectIdentifier(window)] = title
        layoutBanners(animate: false)
        log("banner show queue=\(banners.count) title=\(title)")
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            window.animator().alphaValue = 1
        }
        NSSound(named: NSSound.Name("Glass"))?.play()
        // prd 2.24：可点的通知卡 30s 没被点就自动消失（旧值 60s 会把队列占住一整分钟）。
        let lifetime: TimeInterval = onClick == nil ? 6 : 30
        DispatchQueue.main.asyncAfter(deadline: .now() + lifetime) { [weak self, weak window] in
            guard let window else { return }
            self?.dismissBanner(window, reason: onClick == nil ? "timeout" : "expired")
        }
        return window
    }

    /// 关掉一条横幅并把剩下的整体上移一格（2.21：点最上面一条，下方上顶）。
    private func dismissBanner(_ window: NSWindow, reason: String = "clicked") {
        guard let index = banners.firstIndex(where: { $0 === window }) else { return }
        let title = bannerTitles[ObjectIdentifier(window)] ?? "-"
        banners.remove(at: index)
        bannerTitles.removeValue(forKey: ObjectIdentifier(window))
        log("banner dismiss reason=\(reason) remaining=\(banners.count) title=\(title)")
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.16
            window.animator().alphaValue = 0
        }, completionHandler: {
            window.orderOut(nil)
        })
        layoutBanners(animate: true)
    }

    /// 把一组 id 标为已读：横幅确认后与面板行共用同一份未读数据（2.21）。
    private func markSeen(ids: [String]) {
        guard !ids.isEmpty else { return }
        let raw = lastResolvedURLString.split(separator: "|").first.map(String.init) ?? ""
        guard var components = URLComponents(string: raw), components.host != nil else { return }
        var segments = components.path.split(separator: "/").map(String.init)
        if let last = segments.last, last.hasPrefix("radar") {
            segments[segments.count - 1] = "seen"
        } else {
            segments.append("seen")
        }
        components.path = "/" + segments.joined(separator: "/")
        components.queryItems = [URLQueryItem(name: "id", value: ids.joined(separator: ","))]
        guard let url = components.url else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.fetchNow(reason: "after-banner-confirm") }
        }.resume()
        log("banner confirm \(ids.count) item(s)")
    }

    private func appleScriptString(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        return "\"" + escaped + "\""
    }

    private func syncPulseTimer() {
        let wanted = state.approvals > 0 || state.questions > 0 || state.doneUnread > 0
        if wanted, pulseTimer == nil {
            let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
                guard let self, let circleView = self.circleView else { return }
                self.pulsePhase += 0.05 / HUD.pulsePeriod
                if self.pulsePhase >= 1 { self.pulsePhase -= 1 }
                circleView.pulse = self.pulsePhase
            }
            RunLoop.main.add(timer, forMode: .common)
            pulseTimer = timer
            // 绿呼吸/红呼吸的唯一驱动条件就是这三个计数，日志留证便于验收。
            log("pulse on approvals=\(state.approvals) questions=\(state.questions) doneUnread=\(state.doneUnread)")
        } else if !wanted, let timer = pulseTimer {
            timer.invalidate()
            pulseTimer = nil
            pulsePhase = 0
            circleView?.pulse = 0
            log("pulse off")
        }
    }

    func hudMouseEntered() {
        collapseTimer?.invalidate()
        collapseTimer = nil
        if !isExpanded {
            setExpanded(true, animated: true)
        }
    }

    func hudMouseExited() {
        // 拖拽过程中鼠标必然会离开圆形范围，此时收起了就再也不会回到新位置。
        guard !isDragging else { return }
        guard isExpanded, !options.forceExpanded else { return }
        // 从横幅点进来的详情/审批，鼠标本来就停在横幅上（面板外）。若按 hover 规则
        // 自动收起，用户会看到面板闪一下就没了。详情或待审批期间一律不自动收起。
        guard detailMode == .summary, pendingApprovalId == nil else { return }
        scheduleCollapse()
    }

    private func scheduleCollapse() {
        collapseTimer?.invalidate()
        let timer = Timer(timeInterval: HUD.collapseDelay, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.collapseTimer = nil
            guard self.isExpanded, !self.options.forceExpanded else { return }
            guard self.detailMode == .summary, self.pendingApprovalId == nil else { return }
            self.setExpanded(false, animated: true)
        }
        RunLoop.main.add(timer, forMode: .common)
        collapseTimer = timer
    }

    func handleMouseDown(_ event: NSEvent) {
        guard let window else { return }
        // 双击才激活 DSH；单击什么都不做（只保留拖动能力）。
        if event.clickCount >= 2 {
            log("double click -> activate DSH")
            activateDSH()
            return
        }

        collapseTimer?.invalidate()
        collapseTimer = nil
        isDragging = true
        dragMoved = false
        dragStartMouse = NSEvent.mouseLocation
        dragStartOrigin = window.frame.origin
    }

    func handleMouseDragged(_ event: NSEvent) {
        guard isDragging, let window, let start = dragStartMouse else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - start.x
        let dy = now.y - start.y
        if !dragMoved, hypot(dx, dy) >= 2 { dragMoved = true }
        guard dragMoved else { return }
        window.setFrameOrigin(NSPoint(x: dragStartOrigin.x + dx,
                                      y: dragStartOrigin.y + dy))
    }

    /// 滚轮事件（根视图转发）：事件流与原始 payload 两种形态都支持翻页。
    func handleScroll(_ event: NSEvent) {
        switch detailMode {
        case .events:
            panelContent?.scrollEvents(by: event.scrollingDeltaY)
        case .raw:
            panelContent?.scrollRaw(by: event.scrollingDeltaY)
        case .summary, .approval, .children:
            break
        }
    }

    func handleMouseUp(_ event: NSEvent) {
        if event.timestamp - lastMouseUpTimestamp < 0.02 { return }
        lastMouseUpTimestamp = event.timestamp
        log("mouseUp detail=\(detail != nil) mode=\(detailMode) dragMoved=\(dragMoved) isDragging=\(isDragging)")
        guard isDragging else { return }
        isDragging = false
        dragStartMouse = nil
        guard let window else { return }
        if dragMoved {
            let frame = window.frame.origin
            circleOrigin = isExpanded
                ? NSPoint(x: frame.x + circleInPanel.x, y: frame.y + circleInPanel.y)
                : frame
            circleOrigin = clampedCircleOrigin(circleOrigin)
            saveOrigin(circleOrigin)
            log("window moved to \(NSStringFromPoint(circleOrigin)) expanded=\(isExpanded ? 1 : 0)")
            // 拖动后指针通常已在窗口外：主动收起一次，落点即用户放下的位置。
            if isExpanded, !options.forceExpanded, !rootHovered() {
                setExpanded(false, animated: true)
            }
        } else if detail != nil {
            // 打开详情的那一次点击可能触发窗口尺寸变化，进而再投递一个 mouseUp；
            // 200ms 内的第二次点击一律忽略，避免刚打开就关掉。
            if Date().timeIntervalSince(detailOpenedAt) < 0.25 {
                dragMoved = false
                return
            }
            if let panelContent, isExpanded {
                let local = panelContent.convert(event.locationInWindow, from: nil)
                if panelContent.bounds.contains(local) {
                    switch panelContent.detailActionHit(at: local) {
                    case .backToList:
                        closeDetail()
                    case .showEvents:
                        showEvents()
                    case .backToSummary:
                        backToSummary()
                    case .backToEvents:
                        backToEvents()
                    case .approve:
                        decideApproval(approve: true)
                    case .reject:
                        decideApproval(approve: false)
                    case .confirmAnswer:
                        // N-10：固定回「确认」等于替用户编造回答（模型会把它当成真实选择）。
                        // 无 options 时必须让用户真的输入文本。
                        promptAnswers()
                    case .answer(let index):
                        answerQuestion(optionIndex: index)
                    case .jumpSession:
                        let target = detail?.runId ?? ""
                        closeDetail()
                        if !target.isEmpty { jumpToSession(target) }
                    case nil:
                        // 摘要页点空白 = 返回列表；事件流点某行 = 看原始 payload；
                        // 原始 payload 页点空白 = 回事件流。
                        if detailMode == .summary {
                            closeDetail()
                        } else if detailMode == .events,
                                  let index = panelContent.eventRowIndex(at: local) {
                            openRaw(at: index)
                        } else if detailMode == .raw {
                            backToEvents()
                        } else if detailMode == .children,
                                  let id = panelContent.childRowId(at: local) {
                            // 点某个子会话 = 跳到那条会话，看它具体做了什么。
                            jumpToSession(id)
                            closeDetail()
                        }
                    }
                }
            }
        } else if let hit = approvalRowHit(event) {
            openApproval(hit)
        } else if let id = sessionRowHitId(event) {
            // 父会话有子会话 → 先看「它调用了哪些智能体」；没有子会话才直接跳会话。
            if let item = state.items.first(where: { $0.id == id }),
               let kids = item.children, !kids.isEmpty {
                openChildren(item)
            } else if let item = state.items.first(where: { $0.id == id }) {
                openSessionCard(item)
            } else {
                jumpAndConfirm(sessionId: id, itemId: id)
            }
        } else if let path = artifactRowPath(event) {
            openArtifact(path)
        } else if let id = liveRowHitId(event) {
            openDetail(id)
        } else if let id = doneRowHitId(event) {
            // 已完成的会话：标已读并跳回去；已完成的 run：打开结果页。
            if let item = state.items.first(where: { $0.id == id }), item.kind == "session" {
                // prd 2.23：先确认跳转真的落地（client ack 或降级打开 App），
                // 只有 ack 才标已读；降级/失败都不清未读。
                jumpAndConfirm(sessionId: id, itemId: id)
            } else {
                openDetail(id)
            }
        } else if doneStatsHit(event) {
            log("click on done-unread stats -> mark all")
            markAllSeen()
        } else {
            log("single click: no-op")
        }
        dragMoved = false
    }

    /// 命中「待批准」行。
    private func approvalRowHit(_ event: NSEvent) -> (id: String, approvalId: String)? {
        guard isExpanded, let panelContent else { return nil }
        let local = panelContent.convert(event.locationInWindow, from: nil)
        return panelContent.approvalRowHit(at: local)
    }

    /// 打开审批视图：一句话说明 agent 想干什么，底部直接批准/拒绝。
    private func openApproval(_ hit: (id: String, approvalId: String)) {
        guard let item = state.items.first(where: { $0.id == hit.id }) else { return }
        pendingApprovalId = hit.approvalId
        pendingApprovalToken = item.approvalToken
        pendingQuestions = item.questions ?? []
        detailMode = .approval
        detailLastSeq = 0
        let question = item.isQuestion
        var choices: [(questionId: String, label: String)] = []
        if question {
            for (qi, ask) in (item.questions ?? []).enumerated() {
                let qid = ask.id ?? "q\(qi)"
                for option in ask.options ?? [] {
                    choices.append((questionId: qid, label: option.display))
                }
            }
        }
        panelContent?.questionChoices = choices
        panelContent?.isQuestionDetail = question
        panelContent?.questionIdFallback = (item.questions ?? []).first?.id
        detail = RadarDetail(
            title: "\((item.agent ?? "codex").uppercased()) " + (question ? "有问题要问你" : "请求批准"),
            agent: item.agent ?? "codex",
            meta: item.staleApproval == true
                ? "这条审批是宿主重启前留下的，已经没有进程在等它，可以直接忽略"
                : question
                    ? ((item.questions ?? []).allSatisfy { ($0.options ?? []).isEmpty }
                        ? "等你回答 · 这条提问要自由文本，点「✎ 回答…」输入后发送；不答超时按拒绝处理"
                        : "等你回答 · 选一个选项 = 回执该选项；不答超时按拒绝处理")
                    : "等你决定 · 5 分钟内不处理会自动拒绝",
            body: item.title ?? "",
            runId: item.id ?? "",
            live: false
        )
        panelContent?.detailMode = .approval
        panelContent?.detail = detail
        // N-06：点横幅（或列表行）后必须展开，否则「打开详情」是看不见的。
        if !isExpanded { setExpanded(true, animated: true) }
        refreshExpandedGeometry(animated: true)
        log("approval open id=\(hit.approvalId.prefix(8)) expanded=\(isExpanded)")
    }

    /// N-10：自由文本提问的回答入口。
    ///
    /// 无 options 时不能给固定字符串：这里用带文本框的 NSAlert 让用户输入真实内容，
    /// 再按 `{questionId: text}` 回执（bridge 会包成 `{answers:{qid:{answers:[text]}}}`）。
    /// 多问题逐个输入；任何一次取消都整体放弃，绝不半提交。
    /// 边界：这是 HUD 内的轻量输入，不支持多行富文本；需要长答案请在会话里回答。
    private func promptAnswers() {
        let asks = pendingQuestions
        let fallbackQid = panelContent?.questionIdFallback ?? "reply"
        var collected: [String: String] = [:]
        if asks.isEmpty {
            guard let text = promptText(title: "回答这个提问", message: detail?.body ?? "") else {
                log("question free-text cancelled (no question metadata)")
                return
            }
            collected[fallbackQid] = text
        } else {
            for (index, ask) in asks.enumerated() {
                let qid = ask.id ?? "q\(index)"
                let title = asks.count > 1 ? "回答 \(index + 1)/\(asks.count)" : "回答这个提问"
                guard let text = promptText(title: title, message: ask.question ?? detail?.body ?? "") else {
                    log("question free-text cancelled qid=\(qid)")
                    return
                }
                collected[qid] = text
            }
        }
        guard !collected.isEmpty else { return }
        log("question free-text answered count=\(collected.count) keys=\(collected.keys.sorted().joined(separator: ","))")
        decideApproval(approve: true, answers: collected)
    }

    /// 一次单行文本输入（NSAlert + accessory NSTextField）。取消返回 nil。
    private func promptText(title: String, message: String) -> String? {
        log("question free-text prompt title=\(title) message=\(message.prefix(40))")
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message.isEmpty ? "请输入你的回答" : message
        alert.addButton(withTitle: "发送")
        alert.addButton(withTitle: "取消")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.placeholderString = "输入你的回答（可以是一整句话）"
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return nil }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    /// 批准/拒绝：代理到宿主 `/x-radar/approval-decide`，随后收起并刷新。
    /// 选中某个选项 = 回执 {qid: label}（2.20），与 allow/deny 完全分开。
    private func answerQuestion(optionIndex: Int) {
        guard let panelContent, panelContent.questionChoices.indices.contains(optionIndex) else { return }
        let choice = panelContent.questionChoices[optionIndex]
        decideApproval(approve: true, answers: [choice.questionId: choice.label])
    }

    private func decideApproval(approve: Bool, answers: [String: String]? = nil) {
        guard let approvalId = pendingApprovalId else { return }
        let raw = lastResolvedURLString.split(separator: "|").first.map(String.init) ?? ""
        guard var components = URLComponents(string: raw), components.host != nil else { return }
        var segments = components.path.split(separator: "/").map(String.init)
        if let last = segments.last, last.hasPrefix("radar") {
            segments[segments.count - 1] = "approval-decide"
        } else {
            segments.append("approval-decide")
        }
        components.path = "/" + segments.joined(separator: "/")
        var items = [
            URLQueryItem(name: "id", value: approvalId),
            URLQueryItem(name: "decision", value: approve ? "accept" : "decline"),
            URLQueryItem(name: "token", value: pendingApprovalToken ?? ""),
        ]
        if let answers, !answers.isEmpty,
           let data = try? JSONSerialization.data(withJSONObject: answers),
           let json = String(data: data, encoding: .utf8) {
            items.append(URLQueryItem(name: "answers", value: json))
        }
        components.queryItems = items
        guard let url = components.url else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        request.httpMethod = "GET"
        let decision = answers?.isEmpty == false ? "answer" : (approve ? "accept" : "decline")
        URLSession.shared.dataTask(with: request) { data, _, error in
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            var applied = false
            if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                applied = (obj["ok"] as? Bool) == true
            }
            DispatchQueue.main.async {
                log("approval decide \(decision) ok=\(applied) -> \(text.isEmpty ? (error?.localizedDescription ?? "no body") : text)")
                guard applied else {
                    // 旧实现不管桥回 502 都关详情、清 pending，用户以为批了其实没有（R-06）。
                    self.showBanner(title: "批准没有生效", body: text.isEmpty ? "桥未确认，详情已保留，可重试" : String(text.prefix(60)))
                    self.fetchNow(reason: "after-approval-failed")
                    return
                }
                self.pendingApprovalId = nil
                self.pendingApprovalToken = nil
                self.pendingQuestions = []
                self.closeDetail()
                self.fetchNow(reason: "after-approval")
            }
        }.resume()
    }

    /// 命中「运行中的 DSH 会话」行：请求宿主写跳转信箱，并把 DSH 拉到前台。
    private func sessionRowHitId(_ event: NSEvent) -> String? {
        guard isExpanded, let panelContent else { return nil }
        let local = panelContent.convert(event.locationInWindow, from: nil)
        return panelContent.sessionRowId(at: local)
    }

    /// 把「点会话行」翻译成宿主的一次跳转请求（页面侧 client 半轮询消费）。
    private var clientHalf: RadarPayload.ClientHalf?
    private var clientHalfHintShown = false

    /// prd 2.22：宿主起来 30s 还没收到 client.apply beacon 时，一次性提示「跳转需重载页面」。
    private func notifyClientHalf() {
        guard let half = clientHalf else { return }
        guard half.active == false, let hint = half.hint, !clientHalfHintShown else { return }
        clientHalfHintShown = true
        _ = showBanner(title: "跳转需重载页面", body: hint)
        log("banner client-half inactive lastBeacon=\(half.lastBeacon ?? "never")")
    }

    /// 跳转 + 结果确认（prd 2.23）：jump 写盘后轮询 jump-status——
    /// client ack 才标已读；degraded（只打开了 App）与失败都不清未读。
    private func jumpAndConfirm(sessionId: String, itemId: String) {
        guard let base = lastResolvedURLString.split(separator: "|").first.map(String.init),
              var components = URLComponents(string: base), components.host != nil else {
            log("jump: no resolved url")
            return
        }
        var segments = components.path.split(separator: "/").map(String.init)
        if let last = segments.last, last.hasPrefix("radar") {
            segments[segments.count - 1] = "jump"
        } else {
            segments.append("jump")
        }
        components.path = "/" + segments.joined(separator: "/")
        components.queryItems = [URLQueryItem(name: "session", value: sessionId)]
        guard let url = components.url else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            guard let self else { return }
            if let error {
                log("jump failed \(error.localizedDescription) seen=no")
                self.bannerJumpFailed(sessionId: sessionId, reason: "request: \(error.localizedDescription)")
                return
            }
            var jumpId: String?
            if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                jumpId = object["id"] as? String
            }
            log("jump sent session=\(sessionId.prefix(8)) id=\(jumpId ?? "-")")
            self.pollJumpStatus(id: jumpId, sessionId: sessionId, itemId: itemId, attempt: 0)
        }.resume()
        activateDSH()
    }

    /// 轮询 /x-radar/jump-status：1s 一次，覆盖服务端 8s 的降级窗口。
    private func pollJumpStatus(id: String?, sessionId: String, itemId: String, attempt: Int) {
        guard attempt < 12 else {
            log("jump status timeout id=\(id ?? "-") seen=no")
            bannerJumpFailed(sessionId: sessionId, reason: "timeout")
            return
        }
        guard let id,
              let base = lastResolvedURLString.split(separator: "|").first.map(String.init),
              var components = URLComponents(string: base), components.host != nil else {
            log("jump status skipped (no id) seen=no")
            return
        }
        var segments = components.path.split(separator: "/").map(String.init)
        if let last = segments.last, last.hasPrefix("radar") {
            segments[segments.count - 1] = "jump-status"
        } else {
            segments.append("jump-status")
        }
        components.path = "/" + segments.joined(separator: "/")
        components.queryItems = [URLQueryItem(name: "id", value: id)]
        guard let url = components.url else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self else { return }
            var stateText = "unknown"
            if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                stateText = (object["state"] as? String) ?? "unknown"
            }
            switch stateText {
            case "acked":
                log("jump status acked id=\(id) seen=yes")
                self.markSeen(ids: [itemId])
            case "degraded":
                log("jump status degraded id=\(id) seen=no")
                self.bannerJumpFailed(sessionId: sessionId, reason: "degraded")
            case "pending":
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    self?.pollJumpStatus(id: id, sessionId: sessionId, itemId: itemId, attempt: attempt + 1)
                }
            default:
                log("jump status \(stateText) id=\(id) seen=no")
                self.bannerJumpFailed(sessionId: sessionId, reason: stateText)
            }
        }.resume()
    }

    private func bannerJumpFailed(sessionId: String, reason: String) {
        let title = reason == "degraded" ? "已打开 DSH，但没定位到会话" : "跳转没成功，未标记已读"
        let body = reason == "degraded"
            ? "页面侧 client 没在轮询，重载页面后再点会直接跳转"
            : "会话 \(sessionId.prefix(8))：\(reason)"
        _ = showBanner(title: title, body: body)
    }

    private func jumpToSession(_ sessionId: String) {
        let raw = lastResolvedURLString.split(separator: "|").first.map(String.init) ?? ""
        guard var components = URLComponents(string: raw), components.host != nil else {
            log("jump: no resolved url")
            return
        }
        // feed 形如 /x-radar/radar；同一前缀下就是 /x-radar/jump。
        var segments = components.path.split(separator: "/").map(String.init)
        if let last = segments.last, last.hasPrefix("radar") {
            segments[segments.count - 1] = "jump"
        } else {
            segments.append("jump")
        }
        components.path = "/" + segments.joined(separator: "/")
        components.queryItems = [URLQueryItem(name: "session", value: sessionId)]
        guard let url = components.url else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { data, _, error in
            if let error {
                log("jump failed \(error.localizedDescription)")
                return
            }
            log("jump sent session=\(sessionId.prefix(8))")
        }.resume()
        activateDSH()
    }

    /// 命中「运行中的外部任务」行。
    private func liveRowHitId(_ event: NSEvent) -> String? {
        guard isExpanded, let panelContent else { return nil }
        let local = panelContent.convert(event.locationInWindow, from: nil)
        return panelContent.liveRowId(at: local)
    }

    /// 面板展开时，把窗口坐标换算成面板视图坐标，判断是否点在「完成未看」行上。
    private func doneRowHitId(_ event: NSEvent) -> String? {
        guard isExpanded, let panelContent else { return nil }
        let local = panelContent.convert(event.locationInWindow, from: nil)
        return panelContent.doneRowId(at: local)
    }

    private func artifactRowPath(_ event: NSEvent) -> String? {
        guard isExpanded, let panelContent else { return nil }
        let local = panelContent.convert(event.locationInWindow, from: nil)
        return panelContent.artifactRowPath(at: local)
    }

    /// 办公产物：让宿主在 Finder 里定位该文件（`open -R`），不在这里渲染内容。
    private func openArtifact(_ path: String) {
        let raw = lastResolvedURLString.split(separator: "|").first.map(String.init) ?? ""
        guard var components = URLComponents(string: raw), components.host != nil else { return }
        components.path = "/office-artifacts/open"
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        components.query = "path=" + encoded
        guard let url = components.url else { return }
        log("artifact open \(path)")
        URLSession.shared.dataTask(with: url) { _, _, _ in }.resume()
    }

    /// 打开某次外部运行的详情：先置为已读（计数立刻归零），再拉 events 补正文。
    /// 打开「子会话」页：一个父会话调了几个智能体、各自在干什么。
    /// 把毫秒时间戳差转成「12 分钟」「1 小时 6 分」这种可读时长。
    private func humanDuration(_ ms: Double) -> String {
        let seconds = max(0, ms / 1000)
        if seconds < 60 { return "\(Int(seconds)) 秒" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(Int(minutes)) 分钟" }
        let hours = minutes / 60
        return "\(Int(hours)) 小时 \(Int(minutes) - Int(hours) * 60) 分"
    }

    /// 会话行点开先给一张「这次任务做得怎么样」的卡片，而不是直接跳走。
    private func openSessionCard(_ item: RadarItem) {
        let running = item.isRunningSession
        var body: [String] = []
        let now = Date().timeIntervalSince1970 * 1000
        if let fs = item.formatStatus, !fs.isEmpty {
            body.append("当前：\(fs)")
        }
        if let stages = item.stages, !stages.isEmpty {
            let activeIndex = stages.firstIndex { ($0.status ?? "").contains("进行中") }
                ?? stages.firstIndex { ($0.status ?? "").contains("就绪") }
                ?? 0
            let current = stages[activeIndex]
            body.append("阶段 \(activeIndex + 1)/\(stages.count)：\(current.subject ?? "")")
            if let next = stages.dropFirst(activeIndex + 1).first(where: {
                !($0.status ?? "").contains("已完成")
            }) {
                body.append("下一步：\(next.subject ?? "")")
            }
        }
        if running {
            if let started = item.startedAt, started > 0 {
                body.append("状态：进行中 · 已运行 \(humanDuration(now - started))")
            } else {
                body.append("状态：进行中")
            }
            let touched = Double(item.updatedAt ?? 0)
            if touched > 0 {
                body.append("最近活动：\(humanDuration(now - touched))前")
            }
            if let kids = item.children, !kids.isEmpty {
                let done = kids.filter { ($0.taskStatus ?? "").contains("已完成") }.count
                body.append("团队进度：\(done)/\(kids.count) 已完成")
                if let current = kids.first(where: { $0.isRunning }) {
                    body.append("当前成员：\(current.role ?? current.displayTitle)")
                }
            }
            body.append("点下方「跳到会话」可以进对话看具体输出。")
        } else {
            if let started = item.startedAt, let finished = item.finishedAt, finished > started {
                body.append("状态：已完成 · 耗时 \(humanDuration(finished - started))")
            } else {
                body.append("状态：已完成")
            }
            if let finished = item.finishedAt, finished > 0 {
                body.append("完成于：\(humanDuration(now - finished))前")
            }
            if let kids = item.children, !kids.isEmpty {
                let done = kids.filter { ($0.taskStatus ?? "").contains("已完成") }.count
                body.append("团队进度：\(done)/\(kids.count) 已完成")
            }
            body.append("点下方「跳到会话」回到这段对话。")
        }
        detailLastSeq = 0
        let sessionId = item.id ?? ""
        boardDetail(title: item.title ?? "会话",
                    agent: item.agent ?? "dsh",
                    meta: running ? "运行中的会话" : "已完成的会话",
                    body: body.joined(separator: "\n"),
                    sessionId: sessionId,
                    live: running)
        log("session card open \(sessionId)")
    }

    private func boardDetail(title: String, agent: String, meta: String,
                             body: String, sessionId: String, live: Bool) {
        var card = RadarDetail(title: title, agent: agent, meta: meta, body: body)
        card.runId = sessionId
        card.live = live
        card.isSession = true
        detail = card
        detailOpenedAt = Date()
        detailMode = .summary
        panelContent?.detailMode = .summary
        refreshExpandedGeometry(animated: false)
    }

    private func openChildren(_ item: RadarItem) {
        let kids = item.children ?? []
        var detail = RadarDetail(title: item.title ?? "会话", agent: item.agent ?? "dsh",
                                 meta: "\(kids.count) 个子会话", body: "")
        detail.parentId = item.id ?? ""
        detail.children = kids
        self.detail = detail
        detailMode = .children
        detailOpenedAt = Date()
        panelContent?.detailMode = .children
        refreshExpandedGeometry(animated: true)
        log("children open count=\(kids.count) parent=\(item.id ?? "-")")
    }

    private func openDetail(_ id: String) {
        guard let item = state.items.first(where: { $0.id == id }) else { return }
        log("open detail \(id)")
        detailOpenedAt = Date()
        detailLastSeq = 0
        detail = RadarDetail(title: item.title ?? "（无标题）",
                             agent: item.agent ?? "unknown",
                             meta: "加载中…",
                             body: item.finalAnswer ?? "",
                             runId: id,
                             live: item.isRunningSession || item.isRunningRun)
        panelContent?.detail = detail
        // N-06：打开详情必须真的把面板放出来。旧实现只设 detailMode/detail，
        // 点横幅后窗口仍是 56x56 收起态，用户只看到横幅消失。
        if !isExpanded { setExpanded(true, animated: true) }
        refreshExpandedGeometry(animated: true)
        if item.isDoneUnreadRun, !(item.seen ?? false) {
            markSeen([id])
        }
        if item.isReviewRun {
            fetchVerdict(runId: id)
        }
        fetchRunDetail(id: id, title: item.title ?? "（无标题）", agent: item.agent ?? "unknown")
    }

    /// 摘要 → 事件流。
    private func showEvents() {
        guard let detail else { return }
        detailMode = .events
        panelContent?.detailMode = .events
        refreshExpandedGeometry(animated: true)
        if detail.live { startLiveDetail() }
        log("detail -> events count=\(detail.events.count)")
    }

    /// 事件流 → 摘要。
    private func backToSummary() {
        stopLiveDetail()
        detailMode = .summary
        panelContent?.detailMode = .summary
        refreshExpandedGeometry(animated: true)
        log("detail -> summary")
    }

    private func closeDetail() {
        guard detail != nil else { return }
        stopLiveDetail()
        log("close detail")
        detail = nil
        detailMode = .summary
        panelContent?.detail = nil
        panelContent?.detailMode = .summary
        refreshExpandedGeometry(animated: true)
        if !rootHovered() {
            setExpanded(false, animated: true)
        }
    }

    /// `GET /agent-bridge/runs/<id>`：不带 since 是全量，带 since 是增量（实时跟随）。
    /// 读 L1 裁决（待验收/返工中/需你决定的任务，先让用户看到「为什么没过」）。
    private func fetchVerdict(runId: String) {
        guard let base = lastResolvedURLString.split(separator: "|").first,
              var comps = URLComponents(string: String(base)) else { return }
        comps.path = "/dsh-judge/verdict"
        comps.queryItems = [URLQueryItem(name: "run", value: runId)]
        guard let url = comps.url else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self, let data,
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
            if obj["missing"] as? Bool == true { return }
            let verdict = (obj["verdict"] as? String) ?? "unknown"
            let missing = (obj["missing"] as? [String]) ?? []
            let fixes = (obj["required_fixes"] as? [String]) ?? []
            var lines: [String] = ["验收结论：\(verdict)"]
            if !missing.isEmpty { lines.append("缺：" + missing.prefix(2).joined(separator: "；")) }
            if !fixes.isEmpty { lines.append("要改：" + fixes.prefix(2).joined(separator: "；")) }
            let text = lines.joined(separator: "\n")
            DispatchQueue.main.async {
                guard var current = self.detail, current.runId == runId else { return }
                current.body = text + (current.body.isEmpty ? "" : "\n\n" + current.body)
                self.detail = current
                self.panelContent?.detail = current
                self.refreshExpandedGeometry(animated: false)
                log("verdict loaded run=\(runId) verdict=\(verdict)")
            }
        }.resume()
    }

    private func fetchRunDetail(id: String, title: String, agent: String, append: Bool = false) {
        let raw = lastResolvedURLString.split(separator: "|").first.map(String.init) ?? ""
        guard var components = URLComponents(string: raw),
              components.host != nil, components.scheme != nil else { return }
        components.path = "/agent-bridge/runs/\(id)"
        if append, detailLastSeq > 0 {
            components.queryItems = [
                URLQueryItem(name: "since", value: String(detailLastSeq)),
                URLQueryItem(name: "limit", value: "500"),
            ]
        } else {
            components.queryItems = [URLQueryItem(name: "limit", value: "2000")]
        }
        guard let url = components.url else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self, let data else { return }
            let httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            let run = payload["run"] as? [String: Any] ?? [:]
            // 404 / 空 run：宿主里这条记录已经被回收（内存只留最近 50 个 run，且磁盘
            // meta 也不在）。这时不能再按 status 缺省成 "running" 一直 1.5s 重试，
            // 否则用户点开历史行会永远看到「进行中」——改成终态并停表（t17 的 finding）。
            if httpStatus == 404 || run.isEmpty {
                let message = (payload["error"] as? String) ?? "run not found"
                DispatchQueue.main.async {
                    self.stopLiveDetail()
                    guard var current = self.detail, current.runId == id || current.runId.isEmpty else {
                        log("detail missing id=\(self.shortId(id)) status=\(httpStatus) ignored (detail moved)")
                        return
                    }
                    current.live = false
                    current.runStatus = "missing"
                    current.meta = "详情不可用 · 宿主已回收这条记录（\(message)）；已停止刷新"
                    if current.body.isEmpty { current.body = "（这条任务的结果已不在宿主内存里）" }
                    self.detail = current
                    self.panelContent?.detail = current
                    self.refreshExpandedGeometry(animated: false)
                    log("detail missing id=\(self.shortId(id)) status=\(httpStatus) live=0 retry=stopped")
                }
                return
            }
            let events = payload["events"] as? [[String: Any]] ?? []

            var pieces: [String] = []
            var lines: [RadarEventLine] = []
            for event in events {
                let kind = (event["kind"] as? String) ?? "event"
                if kind == "text", let text = event["text"] as? String, !text.isEmpty {
                    pieces.append(text)
                }
                // kind == "event" 是原始 JSON-RPC 通知（mcpServer/startupStatus 之类），
                // 读结果时没有价值，过滤掉避免 12 行一屏被噪声占满。
                if kind == "event" { continue }
                lines.append(self.eventLine(from: event))
            }
            let status = (run["status"] as? String) ?? "running"
            let live = (status == "running" || status == "starting" || status == "queued")
            let finalAnswer = run["finalAnswer"] as? String
            let meta = self.metaText(run: run, status: status)
            let joined = pieces.joined()

            DispatchQueue.main.async {
                guard var current = self.detail else { return }
                let wasAtBottom = self.panelContent?.eventsAtBottom(current) ?? true
                if append {
                    current.events.append(contentsOf: lines)
                    if let answer = finalAnswer, !answer.isEmpty {
                        current.body = answer
                    } else if !joined.isEmpty {
                        current.body += joined
                    }
                } else {
                    current.events = lines
                    current.body = (finalAnswer?.isEmpty == false ? finalAnswer! : joined)
                }
                if let last = current.events.last?.seq {
                    self.detailLastSeq = max(self.detailLastSeq, last)
                }
                current.meta = meta
                current.runStatus = status
                current.live = live
                current.runId = id
                self.detail = current
                self.panelContent?.detail = current
                if self.detailMode == .events, wasAtBottom {
                    self.panelContent?.followEventsTail(current)
                }
                self.refreshExpandedGeometry(animated: false)
                log("detail loaded body=\(current.body.count) chars meta=\(meta) " +
                    "events=\(current.events.count) live=\(live ? 1 : 0)")
                if live {
                    self.startLiveDetail()
                } else {
                    self.stopLiveDetail()
                    if append, !self.detailFinalReloadPending {
                        self.detailFinalReloadPending = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                            guard let self else { return }
                            self.detailFinalReloadPending = false
                            guard let current = self.detail, !current.runId.isEmpty else { return }
                            self.refreshRunSummary(id: current.runId)
                        }
                    }
                }
            }
            if let error {
                log("detail fetch failed: \(error.localizedDescription)")
            }
        }.resume()
    }

    /// 运行结束后只刷新正文与元信息：事件列表已经靠增量累积，不能被一次
    /// 全量拉取截断（超长运行的 eventCount 远大于一次响应能带的条数）。
    private func refreshRunSummary(id: String) {
        let raw = lastResolvedURLString.split(separator: "|").first.map(String.init) ?? ""
        guard var components = URLComponents(string: raw),
              components.host != nil, components.scheme != nil else { return }
        components.path = "/agent-bridge/runs/\(id)"
        components.queryItems = [URLQueryItem(name: "limit", value: "1")]
        guard let url = components.url else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data else { return }
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            let run = payload["run"] as? [String: Any] ?? [:]
            let status = (run["status"] as? String) ?? "done"
            let meta = self.metaText(run: run, status: status)
            let answer = run["finalAnswer"] as? String
            DispatchQueue.main.async {
                guard var current = self.detail, current.runId == id else { return }
                current.meta = meta
                current.runStatus = status
                current.live = (status == "running")
                if let answer, !answer.isEmpty { current.body = answer }
                self.detail = current
                self.panelContent?.detail = current
                self.refreshExpandedGeometry(animated: false)
                log("detail summary refreshed body=\(current.body.count) chars meta=\(meta)")
            }
        }.resume()
    }

    /// 单条事件 → 一行时间线（brief + 原始 payload）。
    private func eventLine(from event: [String: Any]) -> RadarEventLine {
        let kind = (event["kind"] as? String) ?? "event"
        var brief = ""
        switch kind {
        case "text":
            brief = (event["text"] as? String) ?? ""
        case "reasoning":
            brief = (event["text"] as? String) ?? "思考"
        case "item.start", "item.end":
            brief = (event["title"] as? String) ?? (event["itemType"] as? String) ?? ""
        case "turn.start":
            brief = "回合开始"
        case "turn.end":
            brief = (event["status"] as? String) ?? "结束"
        case "usage":
            if let usage = event["usage"] as? [String: Any],
               let total = usage["total"] as? [String: Any],
               let tokens = total["totalTokens"] as? Int {
                brief = "\(tokens) tokens"
            } else {
                brief = "token 用量"
            }
        case "run.created":
            brief = (event["prompt"] as? String) ?? "创建运行"
        case "approval.request":
            brief = "请求批准"
        case "approval.decision":
            brief = (event["decision"] as? String) ?? "批准结果"
        case "status":
            brief = (event["status"] as? String) ?? (event["notification"] as? String) ?? ""
        default:
            brief = (event["text"] as? String) ?? (event["notification"] as? String) ?? ""
        }
        brief = brief.replacingOccurrences(of: "\n", with: " ")
        if brief.count > 76 { brief = String(brief.prefix(76)) + "…" }
        return RadarEventLine(seq: (event["seq"] as? Int) ?? 0,
                              kind: kind,
                              text: brief,
                              raw: rawPayload(for: event))
    }

    /// 事件的原始 JSON：有 raw 字段就展开 raw，否则给出整条记录。
    private func rawPayload(for event: [String: Any]) -> String {
        let body: Any = event["raw"] ?? event
        guard JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body,
                                                     options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return String(describing: body)
        }
        var header = "#\(event["seq"] ?? 0)  \(event["kind"] ?? "event")"
        if let notification = event["notification"] as? String { header += "  \(notification)" }
        if let at = event["at"] as? String { header += "  \(at)" }
        return header + "\n" + text
    }

    private func metaText(run: [String: Any], status: String) -> String {
        var parts: [String] = []
        if let duration = run["durationMs"] as? Int, duration > 0 {
            parts.append(String(format: "耗时 %.1fs", Double(duration) / 1000))
        }
        if let usage = run["usage"] as? [String: Any],
           let total = usage["total"] as? [String: Any],
           let tokens = total["totalTokens"] as? Int, tokens > 0 {
            parts.append("\(tokens) tokens")
        }
        if let count = run["eventCount"] as? Int {
            parts.append("\(count) 事件")
        }
        if parts.isEmpty {
            parts.append(status == "running" ? "进行中" : "已完成")
        }
        return parts.joined(separator: " · ")
    }

    /// 原始 JSON 按 52 字符折行，供小面板逐行滚。
    private func wrapRaw(_ text: String, width: Int = 52) -> [String] {
        var out: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let expanded = line.replacingOccurrences(of: "\t", with: "  ")
            if expanded.isEmpty { out.append(" "); continue }
            var rest = expanded
            while rest.count > width {
                let cut = rest.index(rest.startIndex, offsetBy: width)
                out.append(String(rest[rest.startIndex..<cut]))
                rest = String(rest[cut...])
            }
            out.append(rest)
        }
        return out
    }

    /// 事件流里点某一行 → 三级视图看该事件的原始 payload。
    private func openRaw(at index: Int) {
        guard var current = detail, index >= 0, index < current.events.count else { return }
        let line = current.events[index]
        current.rawTitle = "#\(line.seq) \(line.kind.uppercased())"
        current.rawLines = wrapRaw(line.raw)
        detail = current
        detailMode = .raw
        panelContent?.detail = current
        panelContent?.detailMode = .raw
        refreshExpandedGeometry(animated: true)
        log("raw open seq=\(line.seq) lines=\(current.rawLines.count)")
    }

    private func backToEvents() {
        detailMode = .events
        panelContent?.detailMode = .events
        refreshExpandedGeometry(animated: true)
        log("raw -> events")
    }

    /// 运行还没结束时，1.5s 拉一次增量事件。
    private func startLiveDetail() {
        guard liveDetailTimer == nil, let detail, detail.live, !detail.runId.isEmpty else { return }
        let timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.liveDetailTick()
        }
        RunLoop.main.add(timer, forMode: .common)
        liveDetailTimer = timer
        log("live detail start run=\(detail.runId)")
    }

    private func stopLiveDetail() {
        guard let timer = liveDetailTimer else { return }
        timer.invalidate()
        liveDetailTimer = nil
        log("live detail stop")
    }

    private func liveDetailTick() {
        guard let detail, detail.live, !detail.runId.isEmpty else {
            stopLiveDetail()
            return
        }
        fetchRunDetail(id: detail.runId, title: detail.title, agent: detail.agent, append: true)
    }

    /// 点中面板里「完成未看 N」那行副行。
    private func doneStatsHit(_ event: NSEvent) -> Bool {
        guard isExpanded, let panelContent else { return false }
        let local = panelContent.convert(event.locationInWindow, from: nil)
        return panelContent.doneStatsHit(at: local)
    }

    /// 用最近一次解析到的 feed URL 推出 `/x-radar/seen` 端点（同前缀，`/radar` → `/seen`）。
    private func seenEndpoint(ids: [String]) -> URL? {
        let raw = lastResolvedURLString.split(separator: "|").first.map(String.init) ?? ""
        guard var components = URLComponents(string: raw),
              components.path.hasSuffix("/radar") else { return nil }
        components.path = String(components.path.dropLast("/radar".count)) + "/seen"
        components.queryItems = [URLQueryItem(name: "id", value: ids.joined(separator: ","))]
        return components.url
    }

    /// 把这些外部 agent 结果标为已读：HUD 是只读轮询方，所以只发一次 GET，然后立刻重拉 feed。
    private func markSeen(_ ids: [String]) {
        let valid = ids.filter { !$0.isEmpty }
        guard !valid.isEmpty, let url = seenEndpoint(ids: valid) else {
            log("mark seen skipped ids=\(ids.count)")
            return
        }
        log("mark seen \(valid.count) item(s)")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    log("mark seen failed: \(error.localizedDescription)")
                } else if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                    log("mark seen failed: http \(http.statusCode)")
                }
                self.fetchNow(reason: "after-mark-seen")
            }
        }.resume()
    }

    /// 右键「完成未看全部置为已读」。
    private func markAllSeen() {
        let ids = state.doneRuns.compactMap(\.id)
        guard !ids.isEmpty else {
            log("mark all seen: nothing to do")
            return
        }
        markSeen(ids)
    }

    func showContextMenu(with event: NSEvent, in view: NSView) {
        let menu = buildMenu()
        NSMenu.popUpContextMenu(menu, with: event, for: view)
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self

        let refresh = NSMenuItem(title: "刷新", action: #selector(menuRefresh), keyEquivalent: "")
        refresh.target = self
        menu.addItem(refresh)

        let top = NSMenuItem(title: "置顶开/关", action: #selector(menuToggleTop), keyEquivalent: "")
        top.target = self
        top.state = isTopmost ? .on : .off
        menu.addItem(top)

        let hide = NSMenuItem(title: "隐藏 5 分钟", action: #selector(menuHide), keyEquivalent: "")
        hide.target = self
        menu.addItem(hide)

        let seen = NSMenuItem(title: "完成未看全部置为已读",
                              action: #selector(menuMarkAllSeen), keyEquivalent: "")
        seen.target = self
        seen.isEnabled = true
        menu.addItem(seen)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "退出", action: #selector(menuQuit), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        return menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.item(withTitle: "置顶开/关")?.state = isTopmost ? .on : .off
    }

    @objc private func menuRefresh() {
        log("menu: refresh")
        fetchNow(reason: "menu")
    }

    @objc private func menuMarkAllSeen() {
        log("menu: mark all seen")
        markAllSeen()
    }

    @objc private func menuToggleTop() {
        isTopmost.toggle()
        if let window {
            window.level = isTopmost ? HUD.topLevel : HUD.offLevel
            window.orderFrontRegardless()
            window.invalidateShadow()
        }
        log("menu: 置顶 \(isTopmost ? "开" : "关") level=\(window?.level.rawValue ?? -1)")
    }

    @objc private func menuHide() {
        guard let window else { return }
        log("menu: 隐藏 5 分钟")
        collapseTimer?.invalidate()
        collapseTimer = nil
        setExpanded(false, animated: false)
        window.orderOut(nil)
        hideTimer?.invalidate()
        hideTimer = Timer(timeInterval: 300, repeats: false) { [weak self] _ in
            guard let self, let window = self.window else { return }
            log("5 分钟到，重新显示")
            window.orderFrontRegardless()
            self.hideTimer = nil
        }
        if let hideTimer { RunLoop.main.add(hideTimer, forMode: .common) }
    }

    @objc private func menuQuit() {
        log("menu: 退出")
        shutdown(reason: "menu quit")
    }

    private func activateDSH() {
        log("open DSH app")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", "DeepSeek Harness"]
        do {
            try process.run()
        } catch {
            log("warn: open DSH failed: \(error.localizedDescription)")
        }
    }
}

// MARK: - main

setvbuf(stdout, nil, _IONBF, 0)

private let (options, exitCode) = Options.parse(CommandLine.arguments)
if let exitCode { exit(exitCode) }

let application = NSApplication.shared
_ = application.setActivationPolicy(.accessory)
private let controller = HUDController(options: options)
application.delegate = controller
controller.start()
application.run()
exit(0)
