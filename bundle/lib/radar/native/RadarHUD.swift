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

/// query 值级 percent-encoding（F-02）。
///
/// `components.queryItems = …` 只按 `urlQueryAllowed` 编码，**不编码 `+`**；而服务端用
/// `URLSearchParams` 解析时会把 `+` 解成空格 —— 用户答 `1+1` 到服务端就变成 `1 1`。
/// 这里用更窄的 allowed 集合（字母数字 + `-._~!*'()`）显式编码，`+ & # 空格 中文` 全部转义。
func queryEncoded(_ raw: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~!*'()")
    return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
}

/// 已编码的 query items：配 `percentEncodedQueryItems` 使用（值必须已编码）。
func encodedQueryItems(_ items: [URLQueryItem]) -> [URLQueryItem] {
    items.map { URLQueryItem(name: queryEncoded($0.name), value: queryEncoded($0.value ?? "")) }
}

/// 单行尾部省略（F-05）：显式段落样式，宽度变化时给「…」而不是硬裁半个字。
func ellipsisStyle() -> NSParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byTruncatingTail
    return style
}

/// 单行文本：自动带 byTruncatingTail。
func drawSingleLine(_ text: String, in rect: NSRect, attributes: [NSAttributedString.Key: Any]) {
    var attrs = attributes
    attrs[.paragraphStyle] = ellipsisStyle()
    (text as NSString).draw(in: rect, withAttributes: attrs)
}

private enum HUD {
    /// 收起态圆形的直径（要求 52–56pt，取上限更醒目）。
    static let circleSize: CGFloat = 56
    static let circleRadius: CGFloat = circleSize / 2

    /// 展开态面板宽度 / 圆角。
    static let panelWidth: CGFloat = 320
    static let panelCorner: CGFloat = 18

    /// 圆形徽标距离面板边缘的留白（也是面板距屏幕边缘的留白）。
    static let edgeMargin: CGFloat = 12

    /// 宽胶囊（t4 §1.2 / 用户 2026-11-18：等回答必须直接显示问题首句）。
    /// 布局：左 12 · dot 8 · 间 8 · 文本 T · 间 8 · 图标 18 · 右 12 = 66 + T。
    static let pillHeight: CGFloat = 44
    static let pillCorner: CGFloat = pillHeight / 2
    static let pillTextMin: CGFloat = 112
    static let pillTextMax: CGFloat = 168
    static let pillMaxWidth: CGFloat = 240
    static let pillPadding: CGFloat = 12
    static let pillDot: CGFloat = 8
    static let pillGap: CGFloat = 8
    static let pillIcon: CGFloat = 18
    static let pillFontSize: CGFloat = 12.5
    static let pillChromeWidth: CGFloat = pillPadding + pillDot + pillGap + pillGap + pillIcon + pillPadding

    /// 九态状态色（t4 §2.2）。只允许出现在点 / 环 / 描边(40%) / 右图标上，不得整条填充。
    static let questionColor = NSColor(calibratedRed: 1.0, green: 0.839, blue: 0.039, alpha: 1)      // #FFD60A
    static let approvalColor = NSColor(calibratedRed: 1.0, green: 0.478, blue: 0.102, alpha: 1)      // #FF7A1A
    static let blockedColor = NSColor(calibratedRed: 1.0, green: 0.392, blue: 0.510, alpha: 1)       // #FF6482
    static let failedColor = NSColor(calibratedRed: 1.0, green: 0.271, blue: 0.227, alpha: 1)        // #FF453A
    static let reworkColor = NSColor(calibratedRed: 0.749, green: 0.353, blue: 0.949, alpha: 1)      // #BF5AF2
    static let verifyingColor = NSColor(calibratedRed: 0.039, green: 0.518, blue: 1.0, alpha: 1)     // #0A84FF

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
    /// 指针离开后要连续满足这么久才收（t14-4 ③：连续 400ms）。
    static let collapseDelay: TimeInterval = 0.4
    /// 点击宽限：任何点击触发的变形（面板长高/变矮）后，800ms 内即使指针在框外也不收
    /// （t14-4 ②：用户点最下面一行时面板变矮，指针会瞬间落到框外）。
    static let clickGrace: TimeInterval = 0.8
    /// 判定为拖拽的位移阈值（pt）。2pt 太灵敏：合成点击/手抖会被判成拖拽，于是点击被吞掉。
    static let dragThreshold: CGFloat = 4
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

/// 日志轮转（t5 F-05）：hud.log 超过 10MB 就滚成 .1/.2/.3，最多留三份。
/// 不轮转的话按实测 15.0 B/s 约 7.7 天顶到 10MB，且永不回收。
private let HUD_LOG_MAX_BYTES = 10 * 1024 * 1024
private let HUD_LOG_KEEP = 3

private func rotateHUDFileIfNeeded(_ path: String) {
    let fm = FileManager.default
    guard let attributes = try? fm.attributesOfItem(atPath: path),
          let size = attributes[.size] as? NSNumber,
          size.intValue >= HUD_LOG_MAX_BYTES else { return }
    for index in stride(from: HUD_LOG_KEEP, through: 1, by: -1) {
        let from = index == 1 ? path : "\(path).\(index - 1)"
        let to = "\(path).\(index)"
        guard fm.fileExists(atPath: from) else { continue }
        if index == HUD_LOG_KEEP { try? fm.removeItem(atPath: to) }
        try? fm.moveItem(atPath: from, toPath: to)
    }
}

private func log(_ message: String) {
    let line = "[\(ISOFormatter.string(from: Date()))] \(message)\n"
    print(line, terminator: "")
    fflush(stdout)
    let path = "/tmp/dsh-task-radar/hud.log"
    try? FileManager.default.createDirectory(atPath: "/tmp/dsh-task-radar", withIntermediateDirectories: true)
    rotateHUDFileIfNeeded(path)
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
    /// 九态里的三态（U-13）：待验收 / 返工中 / 卡住。老宿主没有这些字段时一律按 0，
    /// 由 UI 侧再从 items 的 status 兜底（§0.4「缺失按 0、不推断」）。
    var verifying = 0
    var rework = 0
    var blocked = 0

    private enum CodingKeys: String, CodingKey {
        case pending, running, approvals, questions, failed, doneUnread, autoConfirmed
        case verifying, rework, blocked
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
        verifying = RadarCounts.int(c, .verifying)
        rework = RadarCounts.int(c, .rework)
        blocked = RadarCounts.int(c, .blocked)
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
    var header: String?
    var options: [RadarOption]?
    /// 多选：单击只切换选中态，「提交已选」才发送（t4 §3.2）。
    var multiSelect: Bool?

    private enum CodingKeys: String, CodingKey { case id, question, header, options, multiSelect }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        question = try? c.decodeIfPresent(String.self, forKey: .question)
        header = try? c.decodeIfPresent(String.self, forKey: .header)
        options = try? c.decodeIfPresent([RadarOption].self, forKey: .options)
        multiSelect = try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)
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
    /// 父会话 id：主列表只有顶层会话（为空），子会话行从 children 页带上来（t12 跳转语义）。
    var parentId: String?
    var team: Bool?
    var children: [RadarChild]?
    var verdict: String?
    var round: Int?
    var missing: [String]?
    var path: String?
    var formatStatus: String?
    /// 提问的结构化问题与选项（2.20）：行标题用问题原文，选项在面板里逐条可点。
    var questions: [RadarQuestion]?
    /// 会话内提问被雷达接管时的一次性回执通道（requestId + token）；缺省表示只能提醒。
    var answerRequest: String?
    var answerToken: String?
    var answerExpiresInMs: Int?
    /// 详情页的阶段/起止时间（R-16：以前声明了却从不解码）。
    var stages: [RadarStage]?
    var startedAt: Double?
    var finishedAt: Double?

    /// 失败原因的人类可读文本（feed 已截到 200 字，详情页给全量）。
    var error: String?
    /// 桥的 run 记录里子进程是否还活着（t14 续 2）：false 说明进程没了，不该再显示成「进行中」。
    var pidAlive: Bool?
    /// feed 的排序优先级（0=待回答 … 6=已完成），面板顺序必须与 feed 一致（t14 bug 5）。
    var priority: Int?
    /// 同 agent 同标题的连续 done 被折叠时的条数（t14）。
    var count: Int?
    /// 这条会话为什么算「进行中」：turn=真在跑对话，job=后台任务还在跑，children=子会话在跑。
    var runningBy: String?
    /// 该会话此刻还活着几个后台 job（feed 只给 >0 的情况）。
    var jobs: Int?
    /// feed 给的一句补充说明（例如「验收未通过，未自动返工」「等裁决」）。
    var note: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, agent, title, status, finalAnswer, seen, updatedAt, approvalId, childCount, parentId, team, children
        case verdict, round, missing, path, approvalToken, runId, formatStatus, stages, startedAt, finishedAt, stale, questions
        case answerRequest, answerToken, answerExpiresInMs
        case error, priority, count, pidAlive, runningBy, jobs, note
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
        parentId = try? c.decodeIfPresent(String.self, forKey: .parentId)
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
        answerRequest = try? c.decodeIfPresent(String.self, forKey: .answerRequest)
        answerToken = try? c.decodeIfPresent(String.self, forKey: .answerToken)
        answerExpiresInMs = try? c.decodeIfPresent(Int.self, forKey: .answerExpiresInMs)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        pidAlive = try? c.decodeIfPresent(Bool.self, forKey: .pidAlive)
        priority = try? c.decodeIfPresent(Int.self, forKey: .priority)
        count = try? c.decodeIfPresent(Int.self, forKey: .count)
        runningBy = try? c.decodeIfPresent(String.self, forKey: .runningBy)
        jobs = try? c.decodeIfPresent(Int.self, forKey: .jobs)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
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
        /// 页面加载的是旧 bundle（构建指纹不一致）→ 需要整页重载；页面侧会自己 reload。
        var reload: Bool?
        var build: String?
        var hostBuild: String?
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
    /// 九态里的三态（U-13）。feed 没给（老宿主/测试 fixture）时按 items.status 兜底，
    /// 绝不把这三态「推断」成 running/failed —— 那正是 R-06 判 FAIL 的原因。
    var verifying = 0
    var rework = 0
    var blocked = 0

    var blockedCount: Int { blocked > 0 ? blocked : items.filter { $0.status == "blocked" }.count }
    var reworkCount: Int { rework > 0 ? rework : items.filter { $0.status == "rework" }.count }
    var verifyingCount: Int {
        verifying > 0 ? verifying : items.filter { $0.status == "verifying" || $0.status == "unverified" }.count
    }

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
        // 顺序完全跟 feed（t14 bug 5）：feed 已经按 question > approval > failed > running >
        // rework/blocked > verifying > done 排过序并在截断前算完 counts，HUD 不再自己分组重排，
        // 否则两边顺序不一致、running 会被 done 挤到视口外。
        items.sorted { lhs, rhs in
            let lp = lhs.priority ?? 9
            let rp = rhs.priority ?? 9
            if lp != rp { return lp < rp }
            return (lhs.updatedAt ?? 0) > (rhs.updatedAt ?? 0)
        }
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
            out.append(("已完成 \(doneUnread) · 未读", NSColor(calibratedWhite: 0.78, alpha: 0.75)))
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
    /// 详情页右下角「跳到会话」的目标（主会话详情=主会话 id；子会话详情=子会话 id）。
    var jumpSessionId: String = ""
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
    /// 失败 run 的动作页：重试 / 复制错误 / 清掉这条 / 看事件流（t14 体验 bug）。
    case failure
    /// 双击会话行的确认卡：仅从雷达移除 / 跳到 DSH 删除 / 取消。
    case sessionMenu
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
    /// 提问块内的「自由回答」入口：index 指向 questionBlocks。
    case freeAnswer(Int)
    case jumpSession
    /// 失败 run：用同一 prompt 重发一个新 run。
    case retryRun
    /// 失败 run：把完整 error 写进剪贴板。
    case copyError
    /// 失败 run：标已读并从列表移除（磁盘不动）。
    case clearRun
    /// 会话确认卡三项。
    case sessionHide
    case sessionJump
    case sessionCancel
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
    /// `--hover-probe near|far`：零 TCC 下的「悬停不收 / 离开才收」自检，跑完自退。
    var hoverProbe: String?
    /// `--scroll-probe <dy>`：构造一个滚轮事件并直接喂给 handleScroll，验证零位移不翻页。
    var scrollProbe: CGFloat?
    /// `--answer-probe request,token,qid=label`：直接跑一次回执写回请求后自退（验证 HUD→插件通道）。
    var answerProbe: String?
    /// M9 自检：把一份 10 万事件的 events JSON 走**真实**详情管线，量主线程阻塞（t12）。
    var m9Bench: String?
    /// `--decide-probe <approvalId>`：拿一个（通常已失效的）审批 id 走一遍拒绝，
    /// 验证「服务端不确认也要本地收页」这条路径（用户现场：点取消没反应、胶囊卡在桌面）。
    var decideProbe: String?
    /// `--mock-pointer x,y`：只在 `--mock` 下生效，用于悬停判据的确定性自检。
    var mockPointer: NSPoint?
    /// `--hidden`：窗口 alpha=0 且不吃鼠标事件，只跑逻辑与日志（压测/自检用，桌面不可见）。
    var hidden = false
    /// `--state-dir`：radar-url.json / hud.pid 所在目录（多宿主时每个宿主一份）。
    var stateDir: String?
    /// `--grace-probe recent|stale`：故意展开后触发一次收起计时，并按参数把「最近一次交互」
    /// 设成刚刚（recent，期望 deferred）或很久以前（stale，期望立刻收）。
    /// 本机零 TCC 无法合成点击，这是唯一能自动验证 800ms 宽限的手段。
    var graceProbe: String?
    /// `--banner-probe <index>`：本机零 TCC 点不到横幅，用它在队列里按下标模拟一次真实点击。
    var bannerProbe: Int?
    /// `--feed-fail`：每次取数都失败（等价 feed 500/断网），用来验证「失败时不许吞横幅」。
    var feedFail = false
    /// `--click-delay <ms>`：`--click-probe` 的触发延迟（默认 350ms）。
    /// 测量「点击→面板」时要用它避开启动时的展开动画，否则量到的是动画时长。
    var clickDelayMs: Double = 350
    /// `--route-probe <name>`：用 feed 基址拼 `/<name>` 打一次 GET，打状态与响应体后自退。
    /// 零 TCC 下验证「派生路由前缀对不对」的唯一手段（不必真的去点按钮）。
    var routeProbe: String?
    /// `--bench <path>`：每次轮询往该路径追加一行 JSON（t5 F-07），压测取数用。
    var benchOut: String?
    /// `--bench-max-seconds <n>`：`--bench` 模式到点自动退出。
    var benchMaxSeconds: Double = 0
    /// `--click-probe x,y`：启动后按窗口内坐标跑一次「点击落点 → 行」的解析并打日志后自退。
    /// 本机零 TCC（无法合成鼠标），这是验证命中区唯一可自动化的手段。
    var clickProbe: [NSPoint] = []
    /// 每个落点的点击次数（`x,y@2` = 双击）。
    var clickProbeCounts: [Int] = []
    /// `--hold <秒>`：探针跑完后不立刻退出，留出截图时间（只用于取证）。
    var holdSeconds: Double = 0

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
            case "--hover-probe":
                guard let v = value(for: flag, inline: inline),
                      v == "near" || v == "far" || v == "leave" else {
                    log("error: --hover-probe 需要 near|far|leave")
                    return (opts, 2)
                }
                opts.hoverProbe = v
            case "--hidden":
                opts.hidden = true
            case "--mock-pointer":
                guard let v = value(for: flag, inline: inline) else {
                    log("error: --mock-pointer 需要 x,y")
                    return (opts, 2)
                }
                let xy = v.split(separator: ",").compactMap { Double($0) }
                guard xy.count == 2 else {
                    log("error: --mock-pointer 需要 x,y")
                    return (opts, 2)
                }
                opts.mockPointer = NSPoint(x: xy[0], y: xy[1])
            case "--answer-probe":
                guard let v = value(for: flag, inline: inline), v.contains(","), v.contains("=") else {
                    log("error: --answer-probe 需要 request,token,qid=label")
                    return (opts, 2)
                }
                opts.answerProbe = v
            case "--m9-bench":
                guard let v = value(for: flag, inline: inline), !v.isEmpty else {
                    log("error: --m9-bench 需要事件 JSON 文件路径（或 synthetic:N）")
                    return (opts, 2)
                }
                opts.m9Bench = v
            case "--decide-probe":
                guard let v = value(for: flag, inline: inline), !v.isEmpty else {
                    log("error: --decide-probe 需要 approvalId")
                    return (opts, 2)
                }
                opts.decideProbe = v
            case "--scroll-probe":
                guard let v = value(for: flag, inline: inline), let dy = Double(v) else {
                    log("error: --scroll-probe 需要数字")
                    return (opts, 2)
                }
                opts.scrollProbe = CGFloat(dy)
            case "--expand":
                opts.forceExpanded = true
            case "--state-dir":
                guard let v = value(for: flag, inline: inline) else {
                    log("error: --state-dir 缺少值")
                    return (opts, 2)
                }
                opts.stateDir = v
            case "--click-delay":
                guard let v = value(for: flag, inline: inline), let ms = Double(v) else {
                    log("error: --click-delay 需要毫秒数")
                    return (opts, 2)
                }
                opts.clickDelayMs = ms
            case "--feed-fail":
                opts.feedFail = true
            case "--banner-probe":
                guard let v = value(for: flag, inline: inline), let index = Int(v), index >= 0 else {
                    log("error: --banner-probe 需要非负整数下标（0 = 队首）")
                    return (opts, 2)
                }
                opts.bannerProbe = index
            case "--grace-probe":
                guard let v = value(for: flag, inline: inline) else {
                    log("error: --grace-probe 需要 recent|stale")
                    return (opts, 2)
                }
                opts.graceProbe = v
            case "--route-probe":
                guard let v = value(for: flag, inline: inline), !v.isEmpty else {
                    log("error: --route-probe 缺少路由名")
                    return (opts, 2)
                }
                opts.routeProbe = v
            case "--bench":
                guard let v = value(for: flag, inline: inline), !v.isEmpty else {
                    log("error: --bench 缺少输出路径")
                    return (opts, 2)
                }
                opts.benchOut = v
            case "--bench-max-seconds":
                guard let v = value(for: flag, inline: inline), let seconds = Double(v) else {
                    log("error: --bench-max-seconds 需要秒数")
                    return (opts, 2)
                }
                opts.benchMaxSeconds = seconds
            case "--hold":
                guard let v = value(for: flag, inline: inline), let seconds = Double(v) else {
                    log("error: --hold 需要秒数")
                    return (opts, 2)
                }
                opts.holdSeconds = seconds
            case "--click-probe":
                guard let v = value(for: flag, inline: inline) else {
                    log("error: --click-probe 缺少 x,y")
                    return (opts, 2)
                }
                // 语法：`x,y` 单击，`x,y@2` 双击（验证「双击会话行 → 确认卡」）。
                opts.clickProbe = []
                opts.clickProbeCounts = []
                for part in v.split(separator: ";") {
                    let pieces = part.split(separator: "@", maxSplits: 1).map(String.init)
                    let clicks = pieces.count > 1 ? (Int(pieces[1]) ?? 1) : 1
                    let nums = pieces[0].split(separator: ",").compactMap { Double($0) }
                    guard nums.count == 2 else { continue }
                    opts.clickProbe.append(NSPoint(x: nums[0], y: nums[1]))
                    opts.clickProbeCounts.append(max(1, clicks))
                }
                guard !opts.clickProbe.isEmpty else {
                    log("error: --click-probe 需要 x,y 两个数字，收到 \(v)")
                    return (opts, 2)
                }
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
          --click-probe x,y  按窗口内坐标解析一次点击（含分发）并自退；零 TCC 下的命中区自检。
          --route-probe name  用 feed 基址请求 /<name> 并打印 status/body 后自退（路由前缀自检）。
          --click-delay ms     --click-probe 的触发延迟（默认 350，测「点击→面板」时用 1500 避开启动动画）。
          --grace-probe recent|stale  展开后触发一次收起计时：recent=刚点过（应 deferred），
                              stale=很久没点（应立刻收起），跑完自退。
          --hidden          窗口 alpha=0、不吃鼠标事件，只跑逻辑与日志（压测/自检；桌面不可见）。
          --mock-pointer x,y  （仅 --mock）把「指针位置」换成 x,y，用于确定性地验证悬停判据。
          --answer-probe request,token,qid=label  直接发一次回执写回请求后自退（HUD→插件通道自检）。
          --scroll-probe dy  构造一个滚动量为 dy 的滚轮事件喂给 handleScroll 后自退（零位移不该翻页）。
          --hover-probe near|far  把窗口放到指针下（near）或放到默认锚点（far），展开后主动触发
                              一次收起计时，验证「指针在窗口内就不收」，跑完自退。
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
/// 宽胶囊：待回答 / 待批准 / 失败时把状态**和一句人话**直接摊在桌面上（t4 §1.2）。
/// 不画单字角标（用户 2026-11-18 否掉），状态靠颜色 + 前缀 + 图标槽三重可辨。
private final class PillBadgeView: PassthroughView {
    var state = RenderState() {
        didSet(oldState) {
            // 每 2s 轮询都会把整个 state 重新赋一次：内容签名没变就别重绘，
            // 否则空闲态也在持续做无谓的绘制（t5 M1 门 1.0%，用户实机 1.10%）。
            guard state.signature != oldState.signature else { return }
            needsDisplay = true
        }
    }

    /// 已经算好截断的文本（控制器按 T 的实测宽度算，视图只负责画）。
    var text: String = "" {
        didSet { needsDisplay = true }
    }

    /// 状态色（点、描边、图标）。
    var accent: NSColor = .systemYellow {
        didSet { needsDisplay = true }
    }

    /// 右侧图标槽的字形（`?` `✓` `!` `×`），空字符串则保留空槽。
    var glyph: String = "" {
        didSet { needsDisplay = true }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = HUD.pillCorner
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
                                 xRadius: HUD.pillCorner,
                                 yRadius: HUD.pillCorner)
        NSColor(calibratedWhite: 0.08, alpha: 0.92).setFill()
        shape.fill()
        // 描边用状态色 40%：不涂满，避免变成一块色块压在桌面上。
        accent.withAlphaComponent(0.40).setStroke()
        shape.lineWidth = 1
        shape.stroke()

        // 状态点（垂直居中，8pt）
        let dotRect = NSRect(x: HUD.pillPadding,
                             y: bounds.midY - HUD.pillDot / 2,
                             width: HUD.pillDot,
                             height: HUD.pillDot)
        accent.setFill()
        NSBezierPath(ovalIn: dotRect).fill()

        // 文本：单行、尾部省略号；字体与 spec §1.2 一致
        let textX = HUD.pillPadding + HUD.pillDot + HUD.pillGap
        let iconX = bounds.width - HUD.pillPadding - HUD.pillIcon
        let textWidth = max(0, iconX - HUD.pillGap - textX)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        paragraph.alignment = .left
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: HUD.pillFontSize, weight: .medium),
            .foregroundColor: NSColor(calibratedRed: 0.949, green: 0.949, blue: 0.969, alpha: 1.0),
            .paragraphStyle: paragraph,
        ]
        let textRect = NSRect(x: textX, y: bounds.midY - 8, width: textWidth, height: 16)
        (text as NSString).draw(in: textRect, withAttributes: attrs)

        // 右侧图标槽（只有 4 个状态有字形）
        guard !glyph.isEmpty else { return }
        let iconParagraph = NSMutableParagraphStyle()
        iconParagraph.alignment = .center
        let iconAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 16, weight: .semibold),
            .foregroundColor: accent,
            .paragraphStyle: iconParagraph,
        ]
        (glyph as NSString).draw(in: NSRect(x: iconX, y: bounds.midY - 9, width: HUD.pillIcon, height: 18),
                                 withAttributes: iconAttrs)
    }
}

private final class CircleBadgeView: PassthroughView {
    var state = RenderState() {
        didSet(oldState) {
            // 每 2s 轮询都会把整个 state 重新赋一次：内容签名没变就别重绘，
            // 否则空闲态也在持续做无谓的绘制（t5 M1 门 1.0%，用户实机 1.10%）。
            guard state.signature != oldState.signature else { return }
            needsDisplay = true
        }
    }

    /// 呼吸光环：由 Core Animation 自己跑，不驱动 AppKit 重绘。
    /// 旧实现用 20Hz Timer 改 `pulse` 再 needsDisplay 整圆重绘，常驻 CPU 3.0%（t5 M1，门 1.0%）；
    /// 现在静态描边只画一次，呼吸交给图层动画（合成器完成，CPU ≈ 0）。
    private let pulseRing = CAShapeLayer()

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
        pulseRing.fillColor = nil
        pulseRing.lineWidth = 2.0
        pulseRing.opacity = 0
        layer?.addSublayer(pulseRing)
    }

    override func layout() {
        super.layout()
        // 呼吸环与静态环共用同一几何（见 setPulse），不在其外再套一圈，
        // 否则「待回答」的 60° 缺口会被呼吸环补上、「待批准」的双环会变成三环。
        pulseRing.frame = bounds
    }

    /// 状态 → 静态环形态。控制器也会用它来同步呼吸环，所以放在类型上。
    fileprivate static func morph(for state: RenderState) -> Morph {
        if state.offline { return .none }
        if state.questions > 0 { return .gap }
        if state.approvals > 0 { return .double }
        // 九态（U-13）：blocked 复用缺口环（红）、rework 复用双环（紫）、verifying 复用实心环（蓝）。
        // 形态与颜色组合后三态彼此可分，也不与 question/approval/done 撞车。
        if state.blockedCount > 0 { return .gap }
        if state.reworkCount > 0 { return .double }
        if state.verifyingCount > 0 { return .solid }
        if state.doneUnread > 0 { return .solid }
        return .none
    }

    /// 与静态环同几何的路径：呼吸改的是这一圈本身的透明度，不额外画环。
    private func ringPath(for morph: Morph) -> (path: CGPath?, lineWidth: CGFloat) {
        switch morph {
        case .gap:
            let center = NSPoint(x: bounds.midX, y: bounds.midY)
            let arc = NSBezierPath()
            arc.appendArc(withCenter: center, radius: bounds.width / 2 - 3.2,
                          startAngle: 240, endAngle: 300, clockwise: true)
            return (arc.cgPath, 2.6)
        case .double:
            return (CGPath(ellipseIn: bounds.insetBy(dx: 1.5, dy: 1.5), transform: nil), 2.4)
        case .solid:
            return (CGPath(ellipseIn: bounds.insetBy(dx: 1.5, dy: 1.5), transform: nil), 3.4)
        case .none:
            return (nil, 2.0)
        }
    }

    /// 开/关呼吸。`color`/`morph` 与静态环一致：待回答的缺口不会被补上，待批准仍是双环。
    fileprivate func setPulse(active: Bool, color: NSColor, morph: Morph) {
        let key = "pulse"
        let geometry = ringPath(for: morph)
        guard active, let path = geometry.path else {
            pulseRing.removeAnimation(forKey: key)
            pulseRing.opacity = 0
            return
        }
        pulseRing.path = path
        pulseRing.lineWidth = geometry.lineWidth
        pulseRing.strokeColor = color.cgColor
        guard pulseRing.animation(forKey: key) == nil else { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.12
        fade.toValue = 0.95
        fade.duration = HUD.pulsePeriod / 2
        fade.autoreverses = true
        fade.repeatCount = .infinity
        fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        pulseRing.opacity = 0.95
        pulseRing.add(fade, forKey: key)
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    override var isOpaque: Bool { false }

    /// 胶囊环的静态形态（不靠文字、不单靠颜色区分状态）。
    fileprivate enum Morph {
        case none
        case gap
        case double
        case solid
    }

    /// 按形态画环：缺口环 / 双环 / 实心粗环。
    private func drawRing(morph: Morph, color: NSColor) {
        color.withAlphaComponent(0.92).setStroke()
        switch morph {
        case .gap:
            // 60° 缺口朝下（时钟 7 点到 5 点的位置留空），扫过 300°。
            let radius = bounds.width / 2 - 3.2
            let center = NSPoint(x: bounds.midX, y: bounds.midY)
            let ring = NSBezierPath()
            ring.appendArc(withCenter: center, radius: radius,
                           startAngle: 240, endAngle: 300, clockwise: true)
            ring.lineWidth = 2.6
            ring.lineCapStyle = .round
            ring.stroke()
        case .double:
            let inner = NSBezierPath(ovalIn: bounds.insetBy(dx: 1.5, dy: 1.5))
            inner.lineWidth = 2.4
            inner.stroke()
            // 外圈细线：留 1.2pt 间隙，远看是双环。
            let outer = NSBezierPath(ovalIn: bounds.insetBy(dx: -1.6, dy: -1.6))
            color.withAlphaComponent(0.55).setStroke()
            outer.lineWidth = 1.0
            outer.stroke()
        case .solid:
            let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 1.5, dy: 1.5))
            ring.lineWidth = 3.4
            ring.stroke()
        case .none:
            break
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let circle = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(ovalIn: circle)
        NSColor(calibratedWhite: 0.06, alpha: 0.42).setFill()
        path.fill()

        // 状态在静态像素里就必须能分开，而且不能只靠颜色（色盲）+ 不能出现单字缩写（用户看不懂）：
        //   待回答 = 环上留一个 60° 缺口（缺口朝下）
        //   待批准 = 双环（外圈细线 + 内圈实线）
        //   有新完成 = 实心环（更粗）
        //   进行中 = 中性细环
        // 动画只做轻微呼吸（CALayer，见 pulseRing），静止形态本身已可辨。
        let accent: NSColor?
        switch true {
        case state.offline:
            accent = nil
        case state.questions > 0:
            accent = HUD.questionColor
        case state.approvals > 0:
            accent = HUD.approvalColor
        case state.blockedCount > 0:
            accent = HUD.blockedColor
        case state.failed > 0:
            accent = HUD.failedColor
        case state.reworkCount > 0:
            accent = HUD.reworkColor
        case state.verifyingCount > 0:
            accent = HUD.verifyingColor
        case state.doneUnread > 0:
            accent = .systemGreen
        default:
            accent = nil
        }
        let morph = CircleBadgeView.morph(for: state)

        if let accent {
            accent.withAlphaComponent(0.16).setFill()
            path.fill()
            drawRing(morph: morph, color: accent)
            dotView.configure(color: accent, breathing: true)
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
        didSet(oldState) {
            // 每 2s 轮询都会把整个 state 重新赋一次：内容签名没变就别重绘，
            // 否则空闲态也在持续做无谓的绘制（t5 M1 门 1.0%，用户实机 1.10%）。
            guard state.signature != oldState.signature else { return }
            needsDisplay = true
        }
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

    /// 任务列表（摘要页）的顶部行号：一屏 6 行，超过就靠滚轮翻（t14 bug 5）。
    private(set) var listScrollRow = 0

    /// 列表总行数（由 draw 更新，供 scrollPanel 夹取）。
    private var listRowCount = 0

    /// 列表滚动：只改顶部行号，hit 区在下次 draw 里按新偏移重建。
    func scrollList(by deltaY: CGFloat) {
        guard detailMode == .summary else { return }
        // 合成/空滚轮事件会带着 0 的 delta：`deltaY > 0 ? -1 : 1` 会把 0 判成「向下翻一页」，
        // 于是「只移动指针」也会出现 `list scroll row=1`（captain 2026-11-18 抓到的现象）。
        guard abs(deltaY) > 0.1 else { return }
        let page = CGFloat(HUD.maxRows)
        let step = deltaY > 0 ? -1 : 1
        if abs(deltaY) >= page * 6 {  // 触控板/滚轮快滑：按比例多翻几行
            let rows = Int((abs(deltaY) / 12).rounded(.down))
            applyListScroll(to: listScrollRow + max(1, rows) * step)
        } else {
            applyListScroll(to: listScrollRow + step)
        }
    }

    func applyListScroll(to row: Int) {
        let maxRow = max(0, listRowCount - HUD.maxRows)
        let clamped = min(max(0, row), maxRow)
        guard clamped != listScrollRow else { return }
        listScrollRow = clamped
        needsDisplay = true
    }

    /// 列表被重置（开关面板/换数据）时回到顶部。
    func resetListScroll() {
        if listScrollRow != 0 {
            listScrollRow = 0
            needsDisplay = true
        }
    }

    /// 事件流每一行的点击区域（点一行 → 看该事件的原始 JSON）。
    private var eventRowHits: [(rect: NSRect, index: Int)] = []

    /// 「清除已完成」按钮命中。
    func clearDoneHit(at point: NSPoint) -> Bool {
        guard let rect = clearDoneRect else { return false }
        return rect.contains(point)
    }

    func eventRowIndex(at point: NSPoint) -> Int? {
        for hit in eventRowHits where hit.rect.contains(point) {
            return hit.index
        }
        return nil
    }

    /// 详情底部按钮的点击区域。
    fileprivate var detailActionHits: [(rect: NSRect, action: DetailAction)] = []
    /// 当前提问的可点选项：label 与它所属 questionId，点选后回执 {qid: label}（2.20）。
    var questionChoices: [(questionId: String, label: String)] = []
    /// 当前详情是不是「提问」类（无选项时把底部按钮换成「回复 / 取消」）。
    var isQuestionDetail = false
    /// 无选项提问时用来回执的 question id（取第一个问题的 id）。
    var questionIdFallback: String?
    /// 提问页按「问题」分组渲染：每个问题先出正文，再出它自己的选项芯片；
    /// 没有选项的问题额外给一个「自由回答」入口（用户口径 2026-11-19：不能只弹输入框、看不到问题）。
    var questionBlocks: [(id: String, text: String, options: [String], free: Bool,
                          degraded: Bool, multi: Bool)] = []
    /// 每问已选的 label（多选可多个）：用于「● 」高亮，也是 U-18 一次性提交的数据源。
    var questionPicked: [String: [String]] = [:]
    /// 多问/多选时底部要不要画「✓ 提交回答」行（U-18 / §3.3-a）。
    var showsSubmitRow = false
    /// 提交成功后的「已提交 · 不可撤回」提示（U-24）：非 nil 时整页只画这一行且不再响应点击。
    var submittedNotice: String?
    /// 与 questionBlocks 一一对应：这个块有没有可点的自由回答入口（用来算 action 索引）。
    var questionFreeHits: [(rect: NSRect, block: Int)] = []

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

    /// 按**当前几何**把点击点解析成列表行（2026-11-18：captain 真机点击全部 no-op）。
    /// 旧实现只认 `draw(_:)` 期间登记的 hit rect；只要「画完到点击之间」发生过重绘、
    /// 滚动或换态，登记区就会和视觉错位，而日志只留一句 `single click: no-op`。
    /// 这里直接由 listTop/rowHeight/scroll 现算，draw 只是画，不再兼任命中区作者。
    /// 返回行索引（相对可见区）、全局行号与该行矩形，便于日志取证。
    func rowAt(_ point: NSPoint) -> (visibleIndex: Int, row: Int, rect: NSRect, id: String?)? {
        guard expanded else { return nil }
        let padding = HUD.contentPadding
        let band = HUD.bandHeight
        let contentMaxY = growUp ? bounds.height - padding : bounds.height - band
        let headerY = contentMaxY - HUD.headerHeight
        let listTop = headerY - 2
        guard point.x >= padding - 6, point.x <= bounds.width - padding + 6 else { return nil }
        guard point.y <= listTop + 2 else { return nil }
        let offset = (listTop - point.y) / HUD.rowHeight
        guard offset >= 0 else { return nil }
        let visibleIndex = Int(offset)
        guard visibleIndex < HUD.maxRows else { return nil }
        let rect = NSRect(x: padding,
                          y: listTop - CGFloat(visibleIndex + 1) * HUD.rowHeight,
                          width: bounds.width - 2 * padding,
                          height: HUD.rowHeight)
        guard point.y >= rect.minY - 2 else { return nil }
        let rows = state.panelRows
        let row = listScrollRow + visibleIndex
        guard row < rows.count else { return nil }
        return (visibleIndex, row, rect, rows[row].id)
    }

    /// 诊断用：把当前几何下的可见行矩形与 id 打成一行，方便和真机点击坐标对照。
    func rowGeometryDump() -> String {
        let rows = state.panelRows
        let top = rowAt(NSPoint(x: HUD.contentPadding, y: 0))
        _ = top
        let visible = Array(rows.dropFirst(listScrollRow).prefix(HUD.maxRows))
        let padding = HUD.contentPadding
        let band = HUD.bandHeight
        let contentMaxY = growUp ? bounds.height - padding : bounds.height - band
        let listTop = (contentMaxY - HUD.headerHeight) - 2
        var parts: [String] = []
        for (index, item) in visible.enumerated() {
            let y = listTop - CGFloat(index + 1) * HUD.rowHeight
            parts.append("\(index):\(Int(y))-\(Int(y + HUD.rowHeight))#\(item.id ?? "-")")
        }
        return "listTop=\(Int(listTop)) rowH=\(Int(HUD.rowHeight)) scroll=\(listScrollRow) visible=\(visible.count)" +
            " rows=[" + parts.joined(separator: " ") + "]"
    }

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
            case .failure:
                drawFailure(detail)
            case .sessionMenu:
                drawSessionMenu(detail)
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
        // 只有真的带团队任务时才谈完成度；普通会话不给 d/n（用户看不懂 0/1 是什么意思）。
        var headerRight = "\(rows.count) 项"
        let teamKids = rows.filter { $0.team == true }.flatMap { $0.children ?? [] }
        if !teamKids.isEmpty {
            let done = teamKids.filter { ($0.taskStatus ?? "").contains("已完成") }.count
            headerRight = "已完成 \(done)/\(teamKids.count)"
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
        listRowCount = rows.count
        // 数据变短时把滚动位置夹回，避免停在空白页。
        if listScrollRow > max(0, rows.count - HUD.maxRows) {
            listScrollRow = max(0, rows.count - HUD.maxRows)
        }
        let visible = Array(rows.dropFirst(listScrollRow).prefix(HUD.maxRows))
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
                if asks, let id = item.id {
                    // 会话内提问（kind=question，source=dsh）没有桥的 approvalId；
                    // 旧写法要求 approvalId 非空才登记，导致提问行整行不可点。
                    approvalRowHits.append((rect: rect, id: id, approvalId: item.approvalId ?? ""))
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
                    .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.42),
                ]
                // N/M：让用户知道现在停在哪一页，而不是只看到「还有 N 条」。
                let last = min(rows.count, listScrollRow + HUD.maxRows)
                let indicator = "\(listScrollRow + 1)–\(last)/\(rows.count) · 滚轮翻页" as NSString
                indicator.draw(
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
                : (item.isFailedRun ? NSColor.systemRed : badgeColor(for: item.agent ?? "")))
        // 失败行加一条左侧红条：只靠副标题小字，用户扫列表时看不见（t14-2）。
        if item.isFailedRun {
            let bar = NSBezierPath(roundedRect: NSRect(x: rect.minX - 5,
                                                       y: rect.minY + 9,
                                                       width: 3,
                                                       height: rect.height - 18),
                                   xRadius: 1.5, yRadius: 1.5)
            NSColor.systemRed.withAlphaComponent(0.90).setFill()
            bar.fill()
        }
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
        var titleText = item.title?.isEmpty == false ? item.title! : "（无标题）"
        // 同 agent 同标题的连续 done 在 feed 里已折叠，这里把条数标出来（t14）。
        if let count = item.count, count > 1 { titleText += "  ×\(count)" }
        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12.5, weight: .medium),
            .foregroundColor: NSColor(calibratedWhite: 1.0,
                                      alpha: doneUnread ? 0.74 : (approval ? 0.97 : 0.92)),
        ]
        // F-05：单行尾部省略（宽度变化时给「…」，不硬裁）。
        drawSingleLine(titleText, in: NSRect(x: textX, y: rect.minY + 20, width: textWidth, height: 17),
                       attributes: titleAttrs)

        var agentText: String
        if let review = reviewSubtitle(item) {
            agentText = "\((item.agent ?? "unknown").uppercased()) · \(review)"
        } else if item.isQuestion {
            // 就地可答时才说「点选项即答」；自由文本类说「点开看问题、就地输入」；没接管通道说「回 DSH 里答」。
            let hasOptions = (item.questions ?? []).contains { !($0.options ?? []).isEmpty }
            let tail: String
            if item.answerRequest != nil {
                tail = hasOptions ? "点选项即答" : "点开看问题 · 就地输入"
            } else {
                tail = "回 DSH 里答"
            }
            agentText = "\((item.agent ?? "unknown").uppercased()) · 等你回答 · \(tail)"
        } else if item.isFailedRun {
            // 失败行必须说清「失败什么」（t14 bug 3）：优先 feed 给的 error 首句，
            // 老数据没有 error 时退回 finalAnswer / reason 码，最后才是「点击看日志」。
            let candidates: [String?] = [item.error, item.finalAnswer]
            let text = candidates
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty }
            let clipped = text.map { $0.count > 30 ? String($0.prefix(29)) + "…" : $0 } ?? "点击看日志"
            agentText = "\((item.agent ?? "unknown").uppercased()) · 失败 · " + clipped
        } else if approval {
            agentText = "\((item.agent ?? "unknown").uppercased()) · 待批准 · 点击处理"
        } else if doneUnread {
            agentText = "\((item.agent ?? "unknown").uppercased()) · 已完成 · 未读"
        } else if item.isRunningSession {
            // 后台 job 撑起来的「进行中」要说清是什么在跑，否则用户会以为界面在等他（2026-11-19）。
            if item.runningBy == "job", let jobs = item.jobs, jobs > 0 {
                agentText = "\((item.agent ?? "unknown").uppercased()) · 后台任务 \(jobs) 个在跑"
            } else {
                agentText = "\((item.agent ?? "unknown").uppercased()) · 进行中"
            }
        } else if item.isRunningRun {
            agentText = "\((item.agent ?? "unknown").uppercased()) · 进行中"
        } else if item.kind == "session" {
            agentText = "\((item.agent ?? "unknown").uppercased()) · 已完成"
        } else if item.isReviewRun {
            agentText = "\((item.agent ?? "unknown").uppercased()) · 待判别"
        } else {
            agentText = (item.agent ?? "unknown").uppercased()
        }
        // feed 的补充说明（降级过的返工/待验收）必须出现在行上，否则「状态与实际不符」又回来了。
        if !approval, let note = item.note, !note.isEmpty {
            agentText += " · \(note)"
        }
        if !approval, !doneUnread, item.team == true, let count = item.childCount, count > 0 {
            let kids = item.children ?? []
            let done = kids.filter { ($0.taskStatus ?? "").contains("已完成") }.count
            let current = kids.first { $0.isRunning }
            var teamText = " · 已完成 \(done)/\(count)"
            if let current, current.id != item.id {
                let label = current.role ?? current.displayTitle
                teamText += " · 当前 \(label)"
            }
            agentText += teamText
        }
        let agentAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9, weight: .regular),
            .foregroundColor: approval
                ? NSColor.systemOrange.withAlphaComponent(0.85)
                : (item.isFailedRun
                    ? NSColor.systemRed.withAlphaComponent(0.90)
                    : NSColor(calibratedWhite: 1.0, alpha: doneUnread ? 0.52 : 0.42)),
        ]
        drawSingleLine(agentText, in: NSRect(x: textX, y: rect.minY + 5, width: textWidth, height: 13),
                       attributes: agentAttrs)

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

    /// 提问页（用户口径 2026-11-19）：**先显示问题正文**，多问编号，问题自己的选项作为芯片，
    /// 没有选项的问题就地给「自由回答」入口 —— 不允许只弹一个输入框让用户猜在问什么。
    private func drawQuestionPage(_ detail: RadarDetail) {
        let padding = HUD.contentPadding
        let headerY = bounds.height - padding - HUD.headerHeight

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.systemYellow.withAlphaComponent(0.95),
        ]
        ("等你回答" as NSString).draw(
            in: NSRect(x: padding, y: headerY + 10, width: 200, height: 18),
            withAttributes: titleAttrs)

        // U-24：提交成功后只留这一行，并且**不再提供任何可点动作**（不可撤回）。
        if let notice = submittedNotice {
            detailActionHits = []
            questionFreeHits = []
            let para = NSMutableParagraphStyle()
            para.alignment = .center
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 12.5, weight: .semibold),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.96),
                .paragraphStyle: para,
            ]
            (notice as NSString).draw(
                in: NSRect(x: padding, y: bounds.midY - 10, width: bounds.width - 2 * padding, height: 20),
                withAttributes: attrs)
            return
        }

        // 多问时右上角给进度（§3.3-a）：第 k/N 问，k = 已答数 + 1。
        let total = questionBlocks.count
        if total > 1 {
            let answered = questionBlocks.filter { !(questionPicked[$0.id] ?? []).isEmpty }.count
            let progress = "第 \(min(answered + 1, total))/\(total) 问"
            let para = NSMutableParagraphStyle()
            para.alignment = .right
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
                .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.72),
                .paragraphStyle: para,
            ]
            (progress as NSString).draw(
                in: NSRect(x: bounds.width - padding - 90, y: headerY + 10, width: 90, height: 18),
                withAttributes: attrs)
        }

        var y = headerY - 4
        questionFreeHits = []
        var chipIndex = 0
        let blockAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11.5, weight: .medium),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.94),
        ]
        let chipAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
            .foregroundColor: NSColor.white.withAlphaComponent(0.96),
        ]
        let freeAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.90),
        ]
        let degradeAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .regular),
            .foregroundColor: HUD.questionColor.withAlphaComponent(0.92),
        ]
        let multi = questionBlocks.count > 1
        for (bi, block) in questionBlocks.enumerated() {
            if y < HUD.contentPadding + 52 { break }
            let text = block.text.isEmpty ? "（这一题没有正文）" : block.text
            let head = multi ? "\(bi + 1)) \(text)" : text
            let para = NSMutableParagraphStyle()
            para.lineBreakMode = .byTruncatingTail
            para.lineSpacing = 1.5
            var attrs = blockAttrs
            attrs[.paragraphStyle] = para
            (head as NSString).draw(
                with: NSRect(x: padding, y: y - 30, width: bounds.width - 2 * padding, height: 32),
                options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
            y -= 34

            // U-40：没有 options 的提问不能就地作答（自由输入属 K3）。
            // 旧实现在这里给「自由回答」芯片，用户点开只看到一个输入框，等于谎报能力。
            if block.degraded {
                ("该问题只能到会话里回答" as NSString).draw(
                    in: NSRect(x: padding + 2, y: y - 16, width: bounds.width - 2 * padding - 4, height: 16),
                    withAttributes: degradeAttrs)
                y -= 20
                let rect = NSRect(x: padding, y: y - 18, width: bounds.width - 2 * padding, height: 20)
                let path = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
                NSColor.systemBlue.withAlphaComponent(0.26).setFill()
                path.fill()
                ("→ 打开会话" as NSString).draw(
                    in: NSRect(x: rect.minX + 8, y: rect.minY + 4, width: rect.width - 16, height: 14),
                    withAttributes: chipAttrs)
                detailActionHits.append((rect: rect, action: .jumpSession))
                log("no-options degrade qid=\(block.id) action=open-session")
                y -= 30
                continue
            }

            let picked = questionPicked[block.id] ?? []
            for option in block.options {
                if y < HUD.contentPadding + 52 { break }
                let rect = NSRect(x: padding, y: y - 18, width: bounds.width - 2 * padding, height: 20)
                let path = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
                let chosen = picked.contains(option)
                (chosen ? HUD.questionColor.withAlphaComponent(0.34) : NSColor.systemBlue.withAlphaComponent(0.30)).setFill()
                path.fill()
                let mark = chosen ? "● " : "· "
                ((mark + option) as NSString).draw(
                    in: NSRect(x: rect.minX + 8, y: rect.minY + 4, width: rect.width - 16, height: 14),
                    withAttributes: chipAttrs)
                if questionChoices.indices.contains(chipIndex) {
                    detailActionHits.append((rect: rect, action: .answer(chipIndex)))
                }
                chipIndex += 1
                y -= 24
            }
            if block.free, y >= HUD.contentPadding + 52 {
                let rect = NSRect(x: padding, y: y - 18, width: bounds.width - 2 * padding, height: 20)
                let path = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
                NSColor.systemYellow.withAlphaComponent(0.22).setFill()
                path.fill()
                ("✎ 自由回答…" as NSString).draw(
                    in: NSRect(x: rect.minX + 8, y: rect.minY + 4, width: rect.width - 16, height: 14),
                    withAttributes: freeAttrs)
                detailActionHits.append((rect: rect, action: .freeAnswer(bi)))
                y -= 24
            }
            y -= 6
        }
        // U-18：多问/多选时一次性提交全部答案（回执数组长度 == 问题数）。
        if showsSubmitRow, y >= HUD.contentPadding + 30 {
            let rect = NSRect(x: padding, y: y - 20, width: bounds.width - 2 * padding, height: 22)
            let path = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
            NSColor.systemGreen.withAlphaComponent(0.72).setFill()
            path.fill()
            let para = NSMutableParagraphStyle()
            para.alignment = .center
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10.5, weight: .semibold),
                .foregroundColor: NSColor.white.withAlphaComponent(0.98),
                .paragraphStyle: para,
            ]
            (HUDController.multiSubmitLabel as NSString).draw(
                in: NSRect(x: rect.minX + 8, y: rect.minY + 5, width: rect.width - 16, height: 14),
                withAttributes: attrs)
            if !questionChoices.isEmpty {
                detailActionHits.append((rect: rect, action: .answer(questionChoices.count - 1)))
            }
            y -= 26
        }
        drawFooterButton(text: "✕ 取消", align: .left, action: .reject,
                         color: NSColor.white.withAlphaComponent(0.95),
                         background: NSColor.systemRed.withAlphaComponent(0.72))
    }

    /// 审批视图：一句话说明 agent 想干什么，底部直接批准/拒绝。
    private func drawApproval(_ detail: RadarDetail) {
        if isQuestionDetail, !questionBlocks.isEmpty {
            drawQuestionPage(detail)
            return
        }
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

    /// 失败 run 的动作页（t14 体验 bug：失败之后要有下一步）。
    /// 四件事：重试（POST /agent-bridge/runs，同 prompt）、复制错误、清掉这条、看事件流。
    private func drawFailure(_ detail: RadarDetail) {
        let padding = HUD.contentPadding
        let headerY = bounds.height - padding - HUD.headerHeight

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.systemRed.withAlphaComponent(0.95),
        ]
        ("任务失败" as NSString).draw(
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
        y -= 18

        let sep = NSBezierPath()
        sep.move(to: NSPoint(x: padding, y: y + 2))
        sep.line(to: NSPoint(x: bounds.width - padding, y: y + 2))
        NSColor(calibratedWhite: 1.0, alpha: 0.08).setStroke()
        sep.lineWidth = 1
        sep.stroke()

        let bodyPara = NSMutableParagraphStyle()
        bodyPara.lineBreakMode = .byTruncatingTail
        bodyPara.lineSpacing = 2
        let bodyAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
            .foregroundColor: NSColor.systemRed.withAlphaComponent(0.88),
            .paragraphStyle: bodyPara,
        ]
        // 错误正文给到「还剩多少空间」，不硬切 3 行：动作按钮必须一直在屏内。
        let bodyTop = y - 4
        let bodyFloor = HUD.contentPadding + 52
        let bodyHeight = max(30, bodyTop - bodyFloor)
        let bodyRect = NSRect(x: padding, y: bodyTop - bodyHeight, width: bounds.width - 2 * padding,
                              height: bodyHeight)
        let body = detail.body.isEmpty ? "（这次失败没有留下错误文本）" : detail.body
        (body as NSString).draw(with: bodyRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
                                attributes: bodyAttrs)

        // 两行按钮，避免 320pt 宽挤成一条。
        drawFooterButton(text: "↻ 重试", align: .left, action: .retryRun,
                         color: NSColor.white.withAlphaComponent(0.98),
                         background: NSColor.systemGreen.withAlphaComponent(0.66))
        drawFooterButton(text: "⧉ 复制错误", align: .right, action: .copyError,
                         color: NSColor.white.withAlphaComponent(0.92),
                         background: NSColor.systemBlue.withAlphaComponent(0.55))
        drawFooterButton2(text: "✕ 清掉这条", align: .left, action: .clearRun,
                          color: NSColor(calibratedWhite: 1.0, alpha: 0.86),
                          background: NSColor(calibratedWhite: 1.0, alpha: 0.14))
        drawFooterButton2(text: "事件流 \(detail.events.count) 条 ›", align: .right, action: .showEvents)
    }

    /// 双击会话行的确认卡（HUD 内，不用 NSAlert）。
    private func drawSessionMenu(_ detail: RadarDetail) {
        let padding = HUD.contentPadding
        let headerY = bounds.height - padding - HUD.headerHeight

        let titleAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.92),
        ]
        ("要处理这个会话吗？" as NSString).draw(
            in: NSRect(x: padding, y: headerY + 10, width: bounds.width - 2 * padding, height: 18),
            withAttributes: titleAttrs)

        let nameAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .regular),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.52),
        ]
        ((detail.title.isEmpty ? "（无标题）" : detail.title) as NSString).draw(
            in: NSRect(x: padding, y: headerY - 10, width: bounds.width - 2 * padding, height: 15),
            withAttributes: nameAttrs)

        let choices: [(String, DetailAction)] = [
            ("仅从雷达移除（推荐）", .sessionHide),
            ("跳到 DSH 里删除", .sessionJump),
            ("取消", .sessionCancel),
        ]
        var optionY = headerY - 42
        let optionAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
            .foregroundColor: NSColor.white.withAlphaComponent(0.96),
        ]
        for (index, choice) in choices.enumerated() {
            let rect = NSRect(x: padding, y: optionY - 20, width: bounds.width - 2 * padding, height: 24)
            let path = NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6)
            (index == 0 ? NSColor.systemBlue.withAlphaComponent(0.32)
                        : NSColor(calibratedWhite: 1.0, alpha: 0.10)).setFill()
            path.fill()
            (choice.0 as NSString).draw(
                in: NSRect(x: rect.minX + 8, y: rect.minY + 5, width: rect.width - 16, height: 15),
                withAttributes: optionAttrs)
            detailActionHits.append((rect: rect, action: choice.1))
            optionY -= 28
        }
        drawFooterLabel(text: "仅从雷达移除不会删除 DSH 里的会话数据", align: .left)
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

    /// 第二行底部按钮（失败页用：第一行放主操作，第二行放次要操作）。
    private func drawFooterButton2(text: String, align: NSTextAlignment, action: DetailAction,
                                   color: NSColor? = nil, background: NSColor? = nil) {
        let padding = HUD.contentPadding
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 9.5, weight: .medium),
            .foregroundColor: color ?? NSColor(calibratedWhite: 1.0, alpha: 0.52),
        ]
        let size = (text as NSString).size(withAttributes: attrs)
        let x = align == .left ? padding : bounds.width - padding - size.width
        let rect = NSRect(x: x - 4, y: HUD.contentPadding + 20,
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
        if !detail.jumpSessionId.isEmpty {
            drawFooterButton(text: "跳到会话 ›", align: .right, action: .jumpSession)
        } else {
            drawFooterLabel(text: detail.children.isEmpty ? "没有子会话" : "点成员跳转", align: .right)
        }
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

    /// 底部「清除已完成」按钮的点击区域（摘要页专用）。
    private var clearDoneRect: NSRect?

    private func drawStats(in bandRect: NSRect) {
        drawClearDoneButton(in: bandRect)
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

    /// 一键清除已完成（t14 bug 4）：没有未读完成时不画按钮，避免空按钮占位。
    private func drawClearDoneButton(in bandRect: NSRect) {
        guard state.doneUnread > 0, !state.offline, detailMode == .summary else {
            clearDoneRect = nil
            return
        }
        let width: CGFloat = 78
        let height: CGFloat = 18
        let rect = NSRect(x: bounds.width - width - HUD.contentPadding,
                          y: bandRect.midY - height / 2,
                          width: width, height: height)
        let pill = NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9)
        NSColor(calibratedWhite: 1.0, alpha: 0.10).setFill()
        pill.fill()
        NSColor(calibratedWhite: 1.0, alpha: 0.16).setStroke()
        pill.lineWidth = 1
        pill.stroke()
        let centered = NSMutableParagraphStyle()
        centered.alignment = .center
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10, weight: .medium),
            .foregroundColor: NSColor(calibratedWhite: 1.0, alpha: 0.78),
            .paragraphStyle: centered,
        ]
        ("清除已完成" as NSString).draw(
            in: NSRect(x: rect.minX, y: rect.midY - 7, width: rect.width, height: 14),
            withAttributes: attrs)
        clearDoneRect = rect
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
    /// 打开详情时指定的模式（失败页要在 fetch 回来后保持 .failure）。
    private var detailForcedMode: DetailMode?
    /// 双击会话行的去抖时间戳（300ms 内只开一次确认卡）。
    private var lastSessionMenuAt = Date.distantPast
    /// 详情打开时刻（用于抑制紧随其后的第二次 mouseUp）。
    private var detailOpenedAt = Date.distantPast
    /// 同一个鼠标up 会被投递两次（根视图 + 内部视图），按时间戳去重。
    private var lastMouseUpTimestamp: TimeInterval = 0
    /// `--click-probe` 只跑一次。
    private var clickProbeDone = false
    private var routeProbeDone = false
    private var graceProbeDone = false
    private var bannerProbeDone = false
    private var feedFailServed = false
    /// 宽胶囊视图与生长方向（右半屏=向左长，左半屏=向右长）。
    private var pillView: PillBadgeView?
    private var capsuleGrowLeft = true
    /// 正在弹输入框：这期间不做详情态对账，避免把用户正在输入的自由文本页刷掉（用户口径 2026-11-19）。
    private var inputFocused = false
    /// 上一次打过的胶囊原因，避免同一原因重复刷日志。
    private var lastCapsuleReason = ""
    private var lastLoggedSignature = ""
    private var lastShadowSignature = ""
    private var shadowDirty = true
    private var lastGoodURL: URL?
    private var lastResolvedDescription = ""
    private var lastResolvedURLString = ""
    /// 详情对应 run 已拿到的最大 seq：实时跟随时用它做增量拉取。
    /// 当前审批视图对应的桥内审批 id（点击批准/拒绝时用）。
    private var pendingApprovalId: String?
    /// DSH 会话内提问的就地回执（plugin 接管后才给 requestId/token）。
    private var pendingAnswerRequest: String?
    private var pendingAnswerToken: String?
    private var pendingAnswerQuestionId: String?
    private var pendingAnswerMulti = false
    private var pendingAnswerLabels: [String] = []
    private var pendingAnswerPicked: Set<String> = []
    private var pendingAnswerOptions: [String] = []
    /// 多选题的提交行：点它才把已选集合发出去（单击选项只切换选中态）。
    fileprivate static let multiSubmitLabel = "✓ 提交答案"
    /// U-24：提交成功后必须出现的文案（不可撤回）。
    private static let submittedLabel = "已提交 · 不可撤回"
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
    /// 展开态专用的指针巡检（4Hz）：不依赖 tracking area 的 mouseExited——
    /// 现场实测「离开不收」就是 mouseExited 没送达造成的。只在展开时跑。
    private var hoverWatchTimer: Timer?
    /// 上一轮巡检时指针是否在窗口内：把「在里面 → 在外面」的边沿当作离开信号，立即收起。
    private var hoverWasInside = false
    /// 最近一次用户交互（点击/滚轮/按键）的时间：收起判定的宽限基准（t14-4）。
    private var lastInteractionDate = Date.distantPast
    /// `--mock-pointer x,y`：把「指针位置」换成给定点，用于零 TCC 下确定性地验证悬停判据。
    /// 只在 `--mock` 下生效（见 Options.parse 的校验）。
    private var mockPointer: NSPoint?

    private func pointerLocation() -> NSPoint {
        mockPointer ?? NSEvent.mouseLocation
    }

    /// 记一次用户交互。点击会让面板立刻变形（换详情页、长短变化），
    /// 收起判据必须以「刚点过」为宽限，否则指针原地不动也会被判成离开。
    private func noteInteraction() {
        lastInteractionDate = Date()
    }
    /// 上一次的呼吸状态指纹：只在状态变化时打日志，避免 2s 轮询刷屏。
    private var lastPulseKey = ""
    /// 指针当前是否还在 HUD 窗口里。
    /// **以几何为准**（2026-11-18 captain 回归）：窗口 frame 一变，`.inVisibleRect` 的
    /// tracking area 会重算，指针明明落在新 frame 内却没有新的 mouseEntered 送达，
    /// `mouseInside` 就停在 false，宽限期一到面板自己收起。几何判定不依赖事件投递。
    private func rootHovered() -> Bool {
        guard let window else { return false }
        return NSMouseInRect(pointerLocation(), window.frame, false)
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

    // MARK: M9 自检（t12）

    /// 把一份事件 JSON 走**真实**详情管线，量「后台解析/建行」与「主线程交接+首屏」。
    ///
    /// M9 的验收对象是主线程阻塞：`JSONSerialization` 与 `eventLine` 必须在后台队列完成，
    /// 主线程只做一次数组交接与首屏绘制（虚拟化只画 `eventVisibleRows` 行）。
    /// 输出一行可被门禁/PR 引用：`m9 n=… parse_bg=…ms rows_bg=…ms apply_main=…ms first_screen=…ms`
    private func runM9Bench(_ spec: String) {
        var payloadIn: [[String: Any]] = []
        var readMs = 0.0
        if spec.hasPrefix("synthetic:") {
            let n = Int(spec.dropFirst("synthetic:".count)) ?? 100_000
            payloadIn = (0..<n).map { index in
                ["i": index,
                 "type": "item.completed",
                 "ts": 1_764_000_000_000 + index,
                 "agent": "codex",
                 "text": "事件 #\(index) 的正文内容，用来模拟十万事件的真实体量"]
            }
        } else {
            let t = DispatchTime.now()
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: spec)) else {
                log("m9 error=read-failed file=\(spec)")
                exit(2)
            }
            readMs = Self.millis(since: t)
            // 解析原始 JSON 也在后台队列里——和 fetchRunDetail 的 dataTask 回调同一性质。
            let parseStart = DispatchTime.now()
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            payloadIn = obj["events"] as? [[String: Any]] ?? []
            log(String(format: "m9 parse_json_bg=%.1fms bytes=%d", Self.millis(since: parseStart), data.count))
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let rowsStart = DispatchTime.now()
            var lines: [RadarEventLine] = []
            lines.reserveCapacity(payloadIn.count)
            for event in payloadIn { lines.append(self.eventLine(from: event)) }
            let rowsMs = Self.millis(since: rowsStart)

            DispatchQueue.main.async {
                // M9-c：先让用户看到「加载中」页（首屏），数据到了再增量填充。
                let loadingStart = DispatchTime.now()
                var loading = RadarDetail(title: "M9 bench", agent: "bench", meta: "加载中…", body: "")
                loading.runStatus = "running"
                self.detail = loading
                self.detailMode = .events
                self.panelContent?.detail = loading
                self.panelContent?.detailMode = .events
                self.setExpanded(true, animated: false)
                self.refreshExpandedGeometry(animated: false)
                self.panelContent?.needsDisplay = true
                self.panelContent?.displayIfNeeded()
                let loadingPaintMs = Self.millis(since: loadingStart)

                let applyStart = DispatchTime.now()
                var benchDetail = RadarDetail(title: "M9 bench", agent: "bench",
                                              meta: "\(lines.count) 事件", body: "")
                benchDetail.events = lines
                benchDetail.runStatus = "done"
                self.detail = benchDetail
                self.detailMode = .events
                self.panelContent?.detail = benchDetail
                self.panelContent?.detailMode = .events
                self.setExpanded(true, animated: false)
                self.refreshExpandedGeometry(animated: false)
                self.panelContent?.needsDisplay = true
                self.panelContent?.displayIfNeeded()
                let firstScreenMs = Self.millis(since: applyStart)

                // 滚动帧：连续滚 20 次，每次都 force display，取最慢一帧近似 p95。
                var frames: [Double] = []
                for _ in 0..<20 {
                    let f = DispatchTime.now()
                    self.panelContent?.scrollEvents(by: -3)
                    self.panelContent?.displayIfNeeded()
                    frames.append(Self.millis(since: f))
                }
                frames.sort()
                let p95 = frames.isEmpty ? 0 : frames[min(frames.count - 1, Int(Double(frames.count) * 0.95))]

                log(String(format: "m9 n=%d parse_bg=%.1fms rows_bg=%.1fms apply_main=%.1fms first_screen=%.1fms loading_paint=%.1fms scroll_p95=%.2fms read=%.1fms",
                           lines.count, 0.0, rowsMs, firstScreenMs, firstScreenMs, loadingPaintMs, p95, readMs))
                self.cleanup()
                exit(0)
            }
        }
    }

    static func millis(since start: DispatchTime) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e6
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
        let pill = PillBadgeView(frame: NSRect(x: 0, y: 0, width: HUD.circleSize, height: HUD.pillHeight))
        pill.state = state
        pill.isHidden = true
        root.addSubview(panel)
        root.addSubview(circle)
        root.addSubview(pill)
        window.contentView = root
        log("window created id=\(window.windowNumber) frame=\(NSStringFromRect(window.frame)) "
            + "note=逐次复用同一 NSWindow（不销毁重建）")

        self.window = window
        self.rootView = root
        self.panelContent = panel
        self.circleView = circle
        self.pillView = pill

        if let mock = options.mockPointer {
            if case .mock = options.source {
                self.mockPointer = mock
            } else {
                log("warn: --mock-pointer 只在 --mock 下生效，已忽略")
            }
        }
        window.setFrameOrigin(circleOrigin)
        layoutContents(in: root)
        window.orderFrontRegardless()
        if options.hidden {
            window.alphaValue = 0
            window.ignoresMouseEvents = true
            log("hidden mode: alpha=0 ignoresMouseEvents=1")
        }
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

        if let probe = options.hoverProbe {
            runHoverProbe(probe)
        }

        if let dy = options.scrollProbe {
            runScrollProbe(dy)
        }

        if let spec = options.answerProbe {
            runAnswerProbe(spec)
        }

        if let id = options.decideProbe {
            runDecideProbe(id)
        }

        // t12 M9 自检：只量「十万事件详情」的主线程开销，不进入常规轮询（bench 自己 exit）。
        if let spec = options.m9Bench {
            runM9Bench(spec)
            return
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

    /// 记录胶囊窗口的可见性/尺寸变化（含原因），供门禁 H-12 判定抖动来源：
    /// 只要出现 `window state` 行，就说明是本进程自己改的（面板开合/隐藏菜单），不是重启。
    private func logWindowState(_ reason: String) {
        guard let window else { return }
        let form = window.frame.width > HUD.circleSize + 0.5 ? "wide-or-panel" : "circle"
        log("window state visible=\(window.isVisible ? 1 : 0) form=\(form) " +
            "frame=\(NSStringFromRect(window.frame)) alpha=\(String(format: "%.2f", window.alphaValue)) " +
            "expanded=\(isExpanded ? 1 : 0) reason=\(reason)")
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
            origin = anchorFromCapsule(window.frame)
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
        } else if window.frame.width > HUD.circleSize + 0.5 {
            // 宽胶囊态拖拽：存的必须还是「圆盘圆心」，否则下次收起会跳位置。
            origin = anchorFromCapsule(window.frame)
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

    /// 回执写回通道自检：`request,token,qid=label` → 走真实 `submitAnswer`（含 URL 拼接、
    /// query 编码、错误分档），结束打一行结果并自退。用于在没有真机点击时验证 HUD→插件这条路。
    /// 拿一个失效审批 id 走一遍「拒绝」：断言服务端不确认时本地也会收页（不许卡住）。
    private func runDecideProbe(_ approvalId: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.40) { [weak self] in
            guard let self else { return }
            self.pendingApprovalId = approvalId
            self.pendingApprovalToken = "probe-token"
            self.detailMode = .approval
            self.detail = RadarDetail(title: "PROBE 审批", agent: "probe", meta: "probe", body: "probe", runId: "probe-run", live: false)
            self.panelContent?.detailMode = .approval
            self.panelContent?.detail = self.detail
            log("decide probe id=\(approvalId) -> decline")
            self.decideApproval(approve: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.20) { exit(0) }
        }
    }

    private func runAnswerProbe(_ spec: String) {
        let parts = spec.split(separator: ",", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3 else {
            log("answer probe: 参数不合法 \(spec)")
            exit(2)
        }
        let request = parts[0]
        let token = parts[1]
        let pair = parts[2].split(separator: "=", maxSplits: 1).map(String.init)
        guard pair.count == 2 else {
            log("answer probe: 缺少 qid=label")
            exit(2)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.30) { [weak self] in
            guard let self else { return }
            // label 以 `!` 开头 = 走自由文本（custom），否则当作选项标签（selected）。
            let free = pair[1].hasPrefix("!")
            let text = free ? String(pair[1].dropFirst()) : pair[1]
            log("answer probe request=\(request) qid=\(pair[0]) kind=\(free ? "custom" : "selected") " +
                "value=\(text.prefix(24)) url=\(self.lastResolvedURLString)")
            self.submitAnswer(request: request, token: token, questionId: pair[0],
                              selected: free ? [] : [text], custom: free ? text : nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.50) { exit(0) }
        }
    }

    /// 零 TCC 的滚动自检：in-process 造一个滚轮事件（不投递、不需要辅助功能权限），
    /// 直接调 handleScroll，把「零位移不翻页」变成可复跑的证据。
    private func runScrollProbe(_ dy: CGFloat) {
        if !isExpanded { setExpanded(true, animated: false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self else { return }
            let before = self.panelContent?.listScrollRow ?? 0
            let rows = self.state.items.count
            if let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                                wheelCount: 1, wheel1: Int32(dy), wheel2: 0, wheel3: 0),
               let event = NSEvent(cgEvent: cg) {
                self.handleScroll(event)
            } else {
                log("scroll probe: 造事件失败 dy=\(dy)")
            }
            let after = self.panelContent?.listScrollRow ?? 0
            log("scroll probe dy=\(dy) rows=\(rows) row=\(before)->\(after)")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.20) { exit(0) }
        }
    }

    /// 零 TCC 的悬停自检，三种模式都自退：
    /// - `near`：把窗口贴到（mock）指针下 → 展开 → 主动 scheduleCollapse()，应 `keep expand reason=cursor-inside`；
    /// - `far`：默认锚点（指针在别处）→ 展开 → scheduleCollapse()，应 `collapse reason=cursor-outside`；
    /// - `leave`：贴指针展开并保持 → 1.2s 后把（mock）指针挪到窗口外 → 由 0.25s 巡检触发收起。
    /// 有 `--mock-pointer` 时全部以它当指针，零 TCC 也能确定性复现「在里面/在外面」。
    private func runHoverProbe(_ mode: String) {
        guard let window else { return }
        if mode == "near" || mode == "leave" {
            let cursor = self.mockPointer ?? NSEvent.mouseLocation
            circleOrigin = clampedCircleOrigin(
                NSPoint(x: cursor.x - HUD.circleSize / 2, y: cursor.y - HUD.circleSize / 2))
            window.setFrameOrigin(circleOrigin)
        }
        log("hover probe mode=\(mode) cursor=\(NSStringFromPoint(pointerLocation())) " +
            "window=\(NSStringFromRect(window.frame)) hovered=\(rootHovered())")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.30) { [weak self] in
            guard let self else { return }
            if !self.isExpanded { self.setExpanded(true, animated: false) }
            if mode == "near" {
                self.scheduleCollapse()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.20) { [weak self] in
                    guard let self else { return }
                    log("hover probe result expanded=\(self.isExpanded) hovered=\(self.rootHovered())")
                    self.cleanup()
                    exit(0)
                }
            }
            if mode == "leave" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.20) { [weak self] in
                    guard let self, let window = self.window else { return }
                    log("hover probe leave before=\(NSStringFromRect(window.frame)) " +
                        "hovered=\(self.rootHovered()) expanded=\(self.isExpanded)")
                    if let mock = self.mockPointer {
                        self.mockPointer = NSPoint(x: mock.x + 400, y: mock.y + 400)
                    } else {
                        window.setFrameOrigin(NSPoint(x: 40, y: 40))
                    }
                    log("hover probe leave after=\(NSStringFromRect(window.frame)) " +
                        "hovered=\(self.rootHovered())")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.90) { [weak self] in
                        guard let self else { return }
                        log("hover probe result expanded=\(self.isExpanded) hovered=\(self.rootHovered())")
                        self.cleanup()
                        exit(0)
                    }
                }
            }
            if mode == "far" {
                self.scheduleCollapse()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.90) { [weak self] in
                    guard let self else { return }
                    log("hover probe result expanded=\(self.isExpanded) hovered=\(self.rootHovered())")
                    self.cleanup()
                    exit(0)
                }
            }
        }
    }


    private func startPolling() {
        pollTimer?.invalidate()
        let timer = Timer(timeInterval: options.interval, repeats: true) { [weak self] _ in
            self?.fetchNow(reason: "timer")
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
        if options.benchOut?.isEmpty == false, options.benchMaxSeconds > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + options.benchMaxSeconds) { [weak self] in
                log("bench max seconds reached \(Int(self?.options.benchMaxSeconds ?? 0))s, exit")
                self?.cleanup()
                exit(0)
            }
        }
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

    // MARK: 压测取数（t5 F-07）

    /// 每轮轮询追加一行 JSON Lines。字段口径见 docs/specs/radar-perf-budget.md：
    /// 拿不到的量一律 null（不许缺席、不许编），`n` 必填，毫秒是小数。
    private var benchPollStarted: Date?

    /// 进程累计 CPU 时间（user+sys，纳秒）。`--bench` 的 M1 用它算真实占用。
    private static func cpuNanos() -> UInt64 {
        var info = rusage_info_v2()
        let ok = withUnsafeMutablePointer(to: &info) { pointer -> Bool in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { rebound in
                proc_pid_rusage(getpid(), RUSAGE_INFO_V2, rebound) == 0
            }
        }
        guard ok else { return 0 }
        return info.ri_user_time + info.ri_system_time
    }

    private var lastBenchCPU: (nanos: UInt64, at: TimeInterval)?

    /// 两次采样之间的 CPU 百分比（0–100，按单核计）。
    private func benchCPUPercent(now: TimeInterval) -> Double? {
        let nanos = HUDController.cpuNanos()
        defer { lastBenchCPU = (nanos, now) }
        guard let last = lastBenchCPU, now > last.at, nanos >= last.nanos else { return nil }
        let used = Double(nanos - last.nanos) / 1_000_000_000
        return (used / (now - last.at)) * 100
    }

    private func writeBenchLine(pollMs: Double?, renderMs: Double?) {
        guard let path = options.benchOut, !path.isEmpty else { return }
        let payload: [String: Any] = [
            "ts": Int(Date().timeIntervalSince1970 * 1000),
            "pid": getpid(),
            "mode": options.hidden ? "hidden" : (options.forceExpanded ? "expanded" : "normal"),
            "n": state.items.count,
            "items": state.items.count,
            "poll_ms": pollMs.map { ($0 * 1000).rounded() / 1000 } as Any? ?? NSNull(),
            "render_ms": renderMs.map { ($0 * 1000).rounded() / 1000 } as Any? ?? NSNull(),
            "panel_ms": NSNull(),
            "banner_ms": NSNull(),
            "cpu_pct": benchCPUPercent(now: Date().timeIntervalSince1970).map { ($0 * 100).rounded() / 100 } as Any? ?? NSNull(),
            "rss_kb": Double(HUDController.residentKB()),
            "detail": detailMode == .summary ? NSNull() : detailModeName(),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return }
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(Data((text + "\n").utf8))
            try? handle.close()
        } else {
            try? (text + "\n").write(toFile: path, atomically: true, encoding: .utf8)
        }
    }

    private func detailModeName() -> String {
        switch detailMode {
        case .summary: return "summary"
        case .events: return "events"
        case .raw: return "raw"
        case .approval: return "approval"
        case .children: return "children"
        case .failure: return "failure"
        case .sessionMenu: return "session-menu"
        }
    }

    /// 常驻内存（KB），`--bench` 的 M3 用。
    static func residentKB() -> Int {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Int(info.resident_size / 1024)
    }

    private func fetchNow(reason: String) {
        guard !fetchInFlight else { return }
        fetchInFlight = true
        benchPollStarted = Date()
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
        // 第一次照常取数（这样横幅能先出现），之后每次都失败 —— 用来验证
        // 「feed 500 不许把已有横幅吞掉」，同时避免「从一开始就没数据、根本没横幅」的假通过。
        if options.feedFail && feedFailServed {
            DispatchQueue.main.async { [weak self] in
                self?.finishOffline(reason: "injected feed failure (--feed-fail)", generation: generation)
            }
            return
        }
        if options.feedFail { feedFailServed = true }
        loadRemoteReal(url: url, generation: generation)
    }

    private func loadRemoteReal(url: URL, generation: Int) {
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
            state.verifying = counts.verifying
            state.rework = counts.rework
            state.blocked = counts.blocked
            state.doneUnreadIds = payload.doneUnreadIds
            state.autoConfirmed = counts.autoConfirmed
            state.items = payload.items
            clientHalf = payload.clientHalf
            state.offline = false
            let renderStarted = Date()
            updateUI(origin: origin)
            // 条目被消费（置读/终态过滤/隐藏）后，对应横幅下一轮就该消失。
            pruneConsumedBanners()
            let renderMs = Date().timeIntervalSince(renderStarted)
            let pollMs = benchPollStarted.map { Date().timeIntervalSince($0) } ?? nil
            writeBenchLine(pollMs: pollMs, renderMs: renderMs)
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
        // 请求失败**不许**批量清横幅：一次 500 不该把提醒吞掉（用户 2026-11-19 要求）。
        if !banners.isEmpty {
            log("banner keep reason=feed-error n=\(banners.count)")
        }
        updateUI(origin: "offline")
    }

    // MARK: 渲染

    /// `--click-probe x,y`：把「启动后第一次拿到数据」当成一次点击来解析，打完日志自退。
    /// 本机零 TCC 不能合成鼠标事件，靠它把命中区做成可机检证据（t14 阻塞项）。
    /// 800ms 点击宽限自检：只改「最近一次交互」的时间戳，其余走真实收起计时。
    /// `--banner-probe <index>`：模拟「点队列里第 index 条横幅」。
    /// 走的是与鼠标点击完全相同的闭包（bannerActions），因此日志/派发/清理都可被验证；
    /// 本机零 TCC（无法合成桌面点击）时，这是唯一能自动验「点横幅 → 跳会话/开详情」的手段。
    private func runBannerProbeIfRequested() {
        guard let index = options.bannerProbe, !bannerProbeDone else { return }
        bannerProbeDone = true
        guard index < banners.count else {
            log("banner probe index=\(index) queue=\(banners.count) result=no-such-banner")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
            return
        }
        let window = banners[index]
        let meta = bannerMeta[ObjectIdentifier(window)]
        let action = bannerActions[ObjectIdentifier(window)]
        log("banner probe index=\(index) queue=\(banners.count) " +
            "kind=\(meta?.kind ?? "-") id=\(meta.map { shortId($0.id) } ?? "-") action=\(action == nil ? "none" : "yes")")
        // 与真实鼠标点击同一条路径（含 `banner click …` 日志与 dismiss），不再分叉。
        handleBannerClick(window)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            log("banner probe after queue=\(self?.banners.count ?? -1)")
            exit(0)
        }
    }

    private func view_dismissBanner(_ window: NSWindow, reason: String) {
        dismissBanner(window, reason: reason)
    }

    private func runGraceProbeIfRequested() {
        guard let mode = options.graceProbe, !graceProbeDone else { return }
        graceProbeDone = true
        if !isExpanded {
            // 不要求调用方传 --expand（那样 forceExpanded 会让「不该收」也变成「收不了」）。
            setExpanded(true, animated: false)
            graceProbeDone = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                self?.runGraceProbeIfRequested()
            }
            return
        }
        switch mode {
        case "recent": lastInteractionDate = Date()
        case "stale": lastInteractionDate = Date(timeIntervalSinceNow: -5)
        default:
            log("grace probe error: unknown mode=\(mode)")
            cleanup()
            exit(2)
        }
        log("grace probe mode=\(mode) expanded=\(isExpanded ? 1 : 0) " +
            "sinceClick=\(String(format: "%.2f", Date().timeIntervalSince(lastInteractionDate)))")
        scheduleCollapse()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            log("grace probe result mode=\(mode) expanded=\(self?.isExpanded == true ? 1 : 0)")
            self?.cleanup()
            exit(0)
        }
    }

    /// 路由自检：`--route-probe clear-done` 证明「派生地址真的落在 /x-radar/<name>」。
    /// 用一个本地假服务器接请求，避免对生产数据产生副作用。
    private func runRouteProbeIfRequested() {
        guard let name = options.routeProbe, !routeProbeDone else { return }
        routeProbeDone = true
        guard var components = feedBaseComponents() else {
            log("route probe name=\(name) error=no-base last=\(lastResolvedURLString)")
            cleanup()
            exit(2)
        }
        components.path = (components.path.isEmpty ? "" : components.path) + "/" + name
        guard let url = components.url else {
            log("route probe name=\(name) error=bad-url path=\(components.path)")
            cleanup()
            exit(2)
        }
        log("route probe name=\(name) url=\(url.absoluteString)")
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            DispatchQueue.main.async {
                log("route probe name=\(name) status=\(status) bytes=\(data?.count ?? 0) " +
                    "body=\(text.prefix(200))")
                if let error {
                    log("route probe name=\(name) error=\(error.localizedDescription)")
                }
                self?.cleanup()
                exit(0)
            }
        }.resume()
    }

    private func runClickProbeIfRequested() {
        guard !options.clickProbe.isEmpty, !clickProbeDone else { return }
        clickProbeDone = true
        guard panelContent != nil, isExpanded, !isAnimatingFrame else {
            log("click probe waiting expanded=\(isExpanded ? 1 : 0) animating=\(isAnimatingFrame ? 1 : 0)")
            clickProbeDone = false
            return
        }
        let probes = options.clickProbe
        runClickProbeStep(probes, index: 0)
    }

    /// 依次点击 `--click-probe` 给出的每个落点（`x,y;x,y;…`），每步都走真实的 `handleMouseUp` 路径，
    /// 这样「点主会话行 → 进子会话页 → 点右下角跳到会话」可以一条命令验完。
    private func runClickProbeStep(_ probes: [NSPoint], index: Int) {
        guard index < probes.count else {
            log("click probe done steps=\(probes.count) hold=\(options.holdSeconds)")
            let delay = options.holdSeconds > 0 ? options.holdSeconds : 0.30
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { exit(0) }
            return
        }
        guard let panelContent else { exit(0) }
        let probe = probes[index]
        let clicks = index < options.clickProbeCounts.count ? options.clickProbeCounts[index] : 1
        let hit = panelContent.rowAt(probe)
        log("click probe[\(index)] point=(\(Int(probe.x)),\(Int(probe.y))) clicks=\(clicks) " +
            "mode=\(detailMode) hit=\(hit.map { "row=\($0.row) id=\($0.id ?? "-")" } ?? "nil") " +
            panelContent.rowGeometryDump())
        if let window {
            let windowPoint = panelContent.convert(probe, to: nil)
            if let synthetic = NSEvent.mouseEvent(with: .leftMouseUp,
                                                  location: windowPoint,
                                                  modifierFlags: [],
                                                  timestamp: ProcessInfo.processInfo.systemUptime,
                                                  windowNumber: window.windowNumber,
                                                  context: nil,
                                                  eventNumber: 0,
                                                  clickCount: clicks,
                                                  pressure: 1) {
                isDragging = true
                dragMoved = false
                handleMouseUp(synthetic)
            }
        }
        // 详情页里的可点区域（chips / 按钮）是绘制时登记的，探针打出来才能定位落点。
        if detail != nil, !panelContent.detailActionHits.isEmpty {
            let rects = panelContent.detailActionHits
                .prefix(12)
                .map { "\($0.action)@\(Int($0.rect.midX)),\(Int($0.rect.midY))" }
                .joined(separator: " ")
            log("click probe[\(index)] actions=[\(rects)]")
        }
        log("click probe[\(index)] after mode=\(detailMode) detail=\(detail != nil) " +
            "jump=\(detail?.jumpSessionId ?? "-") children=\(detail?.children.count ?? 0)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.panelContent?.needsDisplay = true
            self?.runClickProbeStep(probes, index: index + 1)
        }
    }

    private func updateUI(origin: String) {
        guard let window, let panelContent, let circleView else { return }
        let idle = state.idle
        // --hidden：完全不可见 + 不吃鼠标事件，只跑逻辑（压测/自检不该在用户桌面上留任何东西）。
        let wantAlpha: CGFloat = options.hidden ? 0 : (idle ? HUD.idleAlpha : 1.0)
        if window.alphaValue != wantAlpha { window.alphaValue = wantAlpha; shadowDirty = true }

        circleView.state = state
        syncPulse()
        pruneNotifications()
        notifyQuestions()
        notifyFinished()
        notifyApproval()
        notifyReview()
        notifyClientHalf()
        panelContent.state = state
        panelContent.detail = detail
        reconcileOpenDetail()

        if isExpanded, !isAnimatingFrame {
            // 轮询/详情回包引起的重算一律瞬时：120–180ms 的尺寸动画会把「点击→面板」顶到 150ms 门以上，
            // 而且让面板在指针下自己滑动。展开/收起本身的动画在 setExpanded 里，不受这里影响。
            refreshExpandedGeometry(animated: false)
        } else if !isExpanded, !isAnimatingFrame {
            refreshCapsuleGeometry()
        }

        // 阴影重算会重建窗口的阴影位图：只在内容真的变了才做（空闲态每 2s 重算就是白烧 CPU）。
        if shadowDirty || state.signature != lastShadowSignature {
            lastShadowSignature = state.signature
            shadowDirty = false
            window.invalidateShadow()
        }
        if !options.clickProbe.isEmpty {
            // 等这一帧真的画完再解析，否则 rowAt 用的几何还没生效。
            DispatchQueue.main.asyncAfter(deadline: .now() + options.clickDelayMs / 1000.0) { [weak self] in
                self?.runClickProbeIfRequested()
            }
        }
        if options.routeProbe != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                self?.runRouteProbeIfRequested()
            }
        }
        if options.bannerProbe != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                self?.runBannerProbeIfRequested()
            }
        }
        if options.graceProbe != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                self?.runGraceProbeIfRequested()
            }
        }
        if state.signature != lastLoggedSignature {
            lastLoggedSignature = state.signature
            log("render pending=\(state.pending) running=\(state.running) " +
                "approvals=\(state.approvals) questions=\(state.questions) " +
                "failed=\(state.failed) doneUnread=\(state.doneUnread) " +
                "sessions=\(state.runningSessions.count) " +
                "rows=q\(state.questionItems.count),a\(state.approvalItems.count),f\(state.failedRuns.count)," +
                "run\(state.runningRuns.count),rev\(state.reviewRuns.count),done\(state.doneRuns.count) " +
                "mode=\(state.offline ? "offline" : (idle ? "idle" : "active")) " +
                "alpha=\(String(format: "%.2f", window.alphaValue)) " +
                "expanded=\(isExpanded ? 1 : 0) origin=\(origin)")
        }
    }

    // MARK: 展开 / 收起

    /// 提问页正文高度：与 drawQuestionPage 的逐行推进保持一致，多一问就多一段，
    /// 底部预留 52（圆盘带）与「取消」行，保证任何一题的芯片与提交行都在可视区内。
    private func questionPageContentHeight() -> CGFloat {
        let blocks = panelContent?.questionBlocks ?? []
        var h: CGFloat = 6
        for block in blocks {
            h += 34
            if block.degraded {
                h += 20 + 26            // 「只能到会话里回答」+「打开会话」按钮
            } else {
                h += CGFloat(block.options.count) * 24
            }
            if block.free { h += 24 }
            h += 6
        }
        if panelContent?.showsSubmitRow == true { h += 24 }
        h += 26 + 52                    // 底部「取消」行 + 圆盘带安全区
        return h
    }

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
                // 提问页按真实内容算：每个问题 34 + 芯片行 + 自由回答行；多问还要提交行。
                // 旧公式只看 bodyLines，多问时芯片会被 `y < padding + 52` 截掉（U-18 实拍）。
                if panelContent?.isQuestionDetail == true {
                    return HUD.bandHeight + HUD.contentPadding + HUD.headerHeight +
                        questionPageContentHeight()
                }
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

    /// 收起态：按当前状态把窗口调成圆或宽胶囊（宽窄变化即时生效，不做 180ms 插值；
    /// t4 §1.7-a 的动画留作后续，先保证「等回答时第一眼就能读到问题首句」）。
    private func refreshCapsuleGeometry(reason: String = "") {
        guard let window, let rootView, !isExpanded, !isAnimatingFrame else { return }
        // 胶囊同样取整：半像素宽度在 2x 屏上会让圆盘/宽胶囊的右边缘发虚。
        let target = capsuleRect(size: capsuleSize()).integral
        let current = window.frame
        if abs(target.width - current.width) > 0.5 || abs(target.height - current.height) > 0.5 ||
            abs(target.minX - current.minX) > 0.5 || abs(target.minY - current.minY) > 0.5 {
            window.setFrame(target, display: true)
            window.invalidateShadow()
            let form = target.width > HUD.circleSize + 0.5 ? "wide" : "circle"
            let why = reason.isEmpty ? "" : " reason=\(reason)"
            log("capsule form=\(form)\(why) " +
                "frame=\(NSStringFromRect(target)) textW=\(Int(target.width - HUD.pillChromeWidth)) " +
                "anchor=\(NSStringFromPoint(circleOrigin))")
        }
        layoutContents(in: rootView)
    }

    private func layoutContents(in root: HUDRootView) {
        guard let panelContent, let circleView else { return }
        if isAnimatingFrame { return }
        var dirtied = false
        if panelContent.frame != root.bounds { panelContent.frame = root.bounds; dirtied = true }
        if isExpanded {
            let target = NSRect(x: circleInPanel.x, y: circleInPanel.y,
                                width: HUD.circleSize, height: HUD.circleSize)
            if circleView.frame != target { circleView.frame = target; dirtied = true }
            if !panelContent.expanded { panelContent.expanded = true; dirtied = true }
            panelContent.growLeft = growLeft
            panelContent.growUp = growUp
            if panelContent.alphaValue != 1 { panelContent.alphaValue = 1 }
            if circleView.alphaValue != 0 { circleView.alphaValue = 0 }
            if pillView?.isHidden == false { pillView?.isHidden = true }
        } else {
            let wide = pillContent() != nil
            let target = NSRect(x: 0, y: 0, width: HUD.circleSize, height: HUD.circleSize)
            if circleView.frame != target { circleView.frame = target; dirtied = true }
            if panelContent.expanded { panelContent.expanded = false; dirtied = true }
            if panelContent.alphaValue != 0 { panelContent.alphaValue = 0 }
            let circleAlpha: CGFloat = wide ? 0 : 1
            if circleView.alphaValue != circleAlpha { circleView.alphaValue = circleAlpha }
            if circleView.isHidden != wide { circleView.isHidden = wide }
            if let pillView {
                if pillView.isHidden != !wide { pillView.isHidden = !wide }
                if pillView.alphaValue != (wide ? 1 : 0) { pillView.alphaValue = wide ? 1 : 0 }
                if pillView.frame != root.bounds { pillView.frame = root.bounds; dirtied = true }
                let corner = wide ? HUD.pillCorner : HUD.circleRadius
                if pillView.layer?.cornerRadius != corner { pillView.layer?.cornerRadius = corner }
            }
            syncPill()
        }
        if root.expanded != isExpanded { root.expanded = isExpanded; dirtied = true }
        let rootCorner = isExpanded
            ? HUD.panelCorner
            : (pillContent() != nil ? HUD.pillCorner : HUD.circleRadius)
        if root.layer?.cornerRadius != rootCorner { root.layer?.cornerRadius = rootCorner }
        if dirtied {
            panelContent.needsDisplay = true
            circleView.needsDisplay = true
            pillView?.needsDisplay = true
        }
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

    private func startHoverWatch() {
        guard hoverWatchTimer == nil else { return }
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            guard self.isExpanded else { self.stopHoverWatch(); return }
            guard !self.isDragging, !self.options.forceExpanded else { return }
            guard self.detailMode == .summary, self.pendingApprovalId == nil else { return }
            if self.rootHovered() {
                if self.collapseTimer != nil {
                    self.collapseTimer?.invalidate()
                    self.collapseTimer = nil
                    log("keep expand reason=cursor-inside cursor=\(NSStringFromPoint(self.pointerLocation())) " +
                        "window=\(self.window.map { NSStringFromRect($0.frame) } ?? "-")")
                }
                self.hoverWasInside = true
                return
            }
            // 巡检看到「刚才在里面、现在在外面」= 用户真的走了：立刻收，不再等 collapseDelay。
            // 这样最坏延迟 = 一个巡检周期 250ms（要求 ≤400ms）。
            if self.hoverWasInside {
                self.hoverWasInside = false
                self.collapseTimer?.invalidate()
                self.collapseTimer = nil
                // 刚点过 800ms 内不立刻收：点击会让面板变形，指针一时间落到框外是正常的。
                log("collapse tick expanded=\(self.isExpanded) cursor=\(NSStringFromPoint(self.pointerLocation())) " +
                    "window=\(self.window.map { NSStringFromRect($0.frame) } ?? "-") hovered=false")
                if !self.collapseAllowedNow() {
                    log("collapse deferred reason=recent-click")
                    self.scheduleCollapse()
                    return
                }
                log("collapse reason=cursor-outside")
                self.setExpanded(false, animated: true)
                return
            }
            if self.collapseTimer == nil { self.scheduleCollapse() }
        }
        RunLoop.main.add(timer, forMode: .common)
        hoverWatchTimer = timer
    }

    private func stopHoverWatch() {
        hoverWatchTimer?.invalidate()
        hoverWatchTimer = nil
    }

    private func setExpanded(_ expand: Bool, animated: Bool) {
        guard let window, let rootView, let panelContent, let circleView else { return }
        guard expand != isExpanded else { return }

        if expand {
            let geo = expansion(for: NSRect(origin: circleOrigin,
                                           size: NSSize(width: HUD.circleSize, height: HUD.circleSize)))
            isExpanded = true
            startHoverWatch()
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
                    logWindowState("expand-begin")
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
            stopHoverWatch()
            rootView.expanded = false
            panelContent.expanded = false
            let target = capsuleRect(size: capsuleSize())
            if animated {
                isAnimatingFrame = true
                rootView.layer?.cornerRadius = HUD.circleRadius
                NSAnimationContext.runAnimationGroup({ ctx in
                    ctx.duration = HUD.animationDuration
                    ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                    logWindowState("collapse-begin")
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

        // t14-4：重算时固定顶边（内容向下长/缩），只有越出屏幕可用区才翻转；
        // 再把窗口平移到「指针仍在框内」的位置——用户点列表最下面一行时面板会变矮，
        // 指针原地不动就落到框外，旧实现于是当场收起。
        let screen = panelScreen(for: NSRect(origin: circleOrigin,
                                             size: NSSize(width: HUD.circleSize, height: HUD.circleSize)))
        let limit = screen.visibleFrame.insetBy(dx: HUD.edgeMargin, dy: HUD.edgeMargin)
        var targetPanel = geo.panel
        if abs(targetPanel.height - window.frame.height) > 0.5 {
            // 固定顶边：高度变了只改「下边缘」，x/y 的整数部分完全不动。
            targetPanel.origin.y = window.frame.maxY - targetPanel.height
            targetPanel.origin.x = window.frame.origin.x
        }
        targetPanel.origin.y = min(max(targetPanel.origin.y, limit.minY),
                                   max(limit.minY, limit.maxY - targetPanel.height))
        targetPanel.origin.x = min(max(targetPanel.origin.x, limit.minX),
                                   max(limit.minX, limit.maxX - targetPanel.width))
        let pointer = pointerLocation()
        // 只在「指针本来在旧框里、新框装不下它」时跟着指针挪：否则 2s 轮询引起的高度变化
        // 会让面板自己去追一个远在桌面另一头的指针。
        let sinceClick = Date().timeIntervalSince(lastInteractionDate)
        if !targetPanel.contains(pointer), window.frame.contains(pointer), sinceClick < HUD.clickGrace {
            if pointer.y > targetPanel.maxY {
                targetPanel.origin.y = min(pointer.y - targetPanel.height + 12,
                                           max(limit.minY, limit.maxY - targetPanel.height))
            } else if pointer.y < targetPanel.minY {
                targetPanel.origin.y = max(pointer.y - 12, limit.minY)
            }
            if pointer.x > targetPanel.maxX {
                targetPanel.origin.x = min(pointer.x - targetPanel.width + 12,
                                           max(limit.minX, limit.maxX - targetPanel.width))
            } else if pointer.x < targetPanel.minX {
                targetPanel.origin.x = max(pointer.x - 12, limit.minX)
            }
            log("panel follow pointer=\(NSStringFromPoint(pointer)) frame=\(NSStringFromRect(targetPanel))")
        }
        // t14-3：窗口 frame 一律取整。AppKit 在 2x 屏上会把 .5 的坐标画到半像素，
        // 更新时用户看到的就是「点了下面一行，面板有细小偏移」。
        targetPanel = targetPanel.integral
        if abs(window.frame.height - targetPanel.height) > 0.5, window.frame.contains(pointer) {
            // 指针在旧框里且新框还能装下它 → 只改 size，原点保持（不抖）。
            targetPanel.origin = window.frame.origin
        }
        guard abs(window.frame.width - targetPanel.width) > 0.5 ||
                abs(window.frame.height - targetPanel.height) > 0.5 ||
                abs(window.frame.minX - targetPanel.minX) > 0.5 ||
                abs(window.frame.minY - targetPanel.minY) > 0.5 else { return }
        // 圆盘（胶囊本体）必须落在新框内：顶层平移后它可能被甩出去。
        circleInPanel = NSPoint(
            x: min(max(circleInPanel.x, HUD.edgeMargin),
                   max(HUD.edgeMargin, targetPanel.width - HUD.circleSize - HUD.edgeMargin)),
            y: min(max(circleInPanel.y, HUD.edgeMargin),
                   max(HUD.edgeMargin, targetPanel.height - HUD.circleSize - HUD.edgeMargin)))
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
        if rootHovered(), collapseTimer != nil {
            collapseTimer?.invalidate()
            collapseTimer = nil
            log("keep expand reason=pointer-in-new-frame frame=\(NSStringFromRect(targetPanel))")
        }
    }

    // MARK: 交互

    /// 仅在「有需批准」时跑 20fps 的脉冲定时器，其余时间不额外耗电。
    private var notifiedDone: Set<String> = []
    private var notifiedApproval: Set<String> = []
    private var notifiedQuestion: Set<String> = []
    private var notifiedReview: Set<String> = []
    private var notifiedFailed: Set<String> = []
    /// U-18：一次提问里的多个 question 各自的选择；顺序按 answerOrder（= questions 原序，不排序）。
    private var answerOrder: [String] = []
    private var answerSelections: [String: [String]] = [:]
    private var answerMulti: [String: Bool] = [:]
    private var answerOptions: [String: [String]] = [:]
    private var answerCustom: [String: String] = [:]
    /// U-24：提交成功后的提示文案（非 nil 时页面不可点，等收页）。
    private var answerSubmittedNotice: String?
    /// 待答横幅聚合用：只维护一张，计数变化时换标题（U-54 / §2.4-c）。
    private var questionBannerWindow: NSWindow?
    private var questionBannerCount = 0
    /// 评审三态（blocked/rework/verifying）各自一张聚合横幅。
    private var reviewBannerWindows: [String: NSWindow] = [:]
    private var reviewBannerCounts: [String: Int] = [:]

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
    /// U-54：多条待答**只留一张**，数量体现在标题 `等你回答(3)`，不再堆 3 张盖满屏幕。
    private func notifyQuestions() {
        // M5a（t5）：从「拿到 feed」到「横幅真的画出来」的 HUD 段耗时。
        // 单独量它是为了把「轮询间隔 2s」和「HUD 自身慢」分开，别混成一个数。
        let notifyStarted = Date()
        let items = state.questionItems
        let pending = max(state.questions, items.count)
        guard let first = items.first else {
            if let window = questionBannerWindow {
                dismissBanner(window, reason: "no-questions")
                log("banner aggregate cleared kind=question")
            }
            questionBannerWindow = nil
            questionBannerCount = 0
            return
        }
        // 计数没变 → 不重建（避免每 2s 轮询都闪一下横幅）；计数变了 → 换标题。
        guard questionBannerWindow == nil || questionBannerCount != pending else { return }
        if let old = questionBannerWindow { dismissBanner(old, reason: "regroup") }
        let title = pending > 1 ? "等你回答(\(pending))" : "等你回答"
        let body = first.title ?? "agent 有问题要问你"
        let window = showBanner(title: title, body: body,
                                bannerId: first.id, bannerKind: "question") { [weak self] in
            // 提问横幅点击 = 打开处置页（不做跳转，跳转会让用户丢掉回执通道）。
            self?.openApproval((id: first.id ?? "", approvalId: first.approvalId ?? first.id ?? ""))
        }
        questionBannerWindow = window
        questionBannerCount = pending
        log("banner aggregate kind=question n=\(pending) title=\(title) first=\(shortId(first.id ?? ""))")
        if !items.isEmpty {
            let dt = Date().timeIntervalSince(notifyStarted) * 1000
            log(String(format: "banner dt=%.2fms n=%d (M5a HUD 段)", dt, items.count))
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
            showBanner(title: title, body: item.title ?? "有一个任务等你批准",
                       bannerId: id, bannerKind: "approval") { [weak self] in
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
        // 降级过的行（rework/verifying 没有活动 → 按 done 展示并带 note）不是「真完成」，
        // 不能播「任务完成」——用户会以为是新跑完的活（2026-11-19 现场）。
        let done = state.items.filter {
            $0.isDoneUnreadRun && ($0.kind == "run" || $0.kind == "session") &&
            (($0.note ?? "").isEmpty)
        }
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
        let newestKind = newest.kind ?? "run"
        let newestStatus = newest.status ?? "done"
        // 点完成横幅 = 一键到「这条结果所在的地方」：
        //  · session 且已完成 → 标已读 + 直接跳到会话窗口（条目随即从胶囊消失）
        //  · 外部 run（codex/claude/workbuddy）→ 打开该 run 的详情页
        // 折叠卡（N>1）仍先按同一批 id 清理未读，再对「最新那条」执行上面两种动作之一。
        doneBanner = showBanner(title: title, body: body,
                                bannerId: newest.id, bannerKind: newestKind) { [weak self] in
            guard let self else { return }
            self.pendingDoneIds = []
            self.pendingDoneCount = 0
            self.doneBanner = nil
            guard let newestId = newest.id else {
                self.markSeen(ids: ids)
                return
            }
            if newestKind == "session" && newestStatus == "done" {
                log("banner done jump kind=session id=\(self.shortId(newestId))")
                self.markSeen([newestId]) {
                    self.jumpToSession(newestId)
                }
            } else {
                self.markSeen(ids: ids)
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
            showBanner(title: "\(who) 任务失败", body: body,
                       bannerId: failedId, bannerKind: "run") { [weak self] in
                self?.openDetail(failedId)
            }
            log("banner failed \(id.prefix(8))")
        }
        // U-13：blocked / rework / verifying 三种状态在横幅里也必须能看到。
        // 每态聚合成一张（标题带 (N)），同态计数不变就不重建，避免每 2s 刷屏。
        notifyReviewState("blocked", title: "任务卡住", items: state.items.filter { $0.status == "blocked" })
        notifyReviewState("rework", title: "审查未通过", items: state.items.filter { $0.status == "rework" })
        notifyReviewState("verifying", title: "校验中",
                          items: state.items.filter { $0.status == "verifying" || $0.status == "unverified" })
    }

    /// 某一评审态的聚合横幅：只留一张，标题 `任务卡住(2)`，点开最新一条的详情。
    private func notifyReviewState(_ kind: String, title: String, items: [RadarItem]) {
        guard let first = items.first else {
            if let window = reviewBannerWindows[kind] {
                dismissBanner(window, reason: "state-cleared")
                log("banner aggregate cleared kind=\(kind)")
            }
            reviewBannerWindows[kind] = nil
            reviewBannerCounts[kind] = 0
            return
        }
        let count = items.count
        guard reviewBannerWindows[kind] == nil || reviewBannerCounts[kind] != count else { return }
        if let old = reviewBannerWindows[kind] { dismissBanner(old, reason: "regroup") }
        let text = count > 1 ? "\(title)(\(count))" : title
        let id = first.id ?? ""
        let body = first.title ?? first.error ?? first.note ?? "点开看这一条"
        let window = showBanner(title: text, body: body, bannerId: id, bannerKind: kind) { [weak self] in
            self?.openDetail(id)
        }
        reviewBannerWindows[kind] = window
        reviewBannerCounts[kind] = count
        log("banner aggregate kind=\(kind) n=\(count) title=\(text) first=\(shortId(id))")
    }

    /// 通知队列：index 0 是屏幕最上面那一条（最新），点击确认后下方的整体上移一格。
    private var banners: [NSWindow] = []
    /// 每条横幅自己的来源（id/kind）：点击时按这条的事实派发，而不是"点谁都跳到最新一条"。
    private var bannerMeta: [ObjectIdentifier: (id: String, kind: String)] = [:]
    private var bannerActions: [ObjectIdentifier: () -> Void] = [:]
    /// U-31：每条横幅的展示时刻，用来核对「60s / 30s / 6s」到底停在多久。
    private var bannerShownAt: [ObjectIdentifier: Date] = [:]
    /// U-31：到期时刻表（墙钟），由 0.5s 看门狗统一收割，避免依赖会被合并的单次计时器。
    private var bannerDeadlines: [ObjectIdentifier: (deadline: Date, lifetime: TimeInterval,
                                                     kind: String, clickable: Bool)] = [:]
    private var bannerWatchdog: Timer?
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
    /// 上次解析所用的屏幕（缓存，避免每 2s 枚举 NSScreen.screens 又刷日志）。
    private var lastPanelScreenKey = ""

    private func panelScreen(for circle: NSRect) -> NSScreen {
        let count = NSScreen.screens.count
        let anchor = screen(containing: circle)
        let picked: (screen: NSScreen?, source: String)
        if let anchor = anchor {
            picked = (anchor, "circle")
        } else {
            picked = chooseScreen(preferMouse: true)
        }
        let name = picked.screen?.localizedName ?? "?"
        // 只有「来源屏幕/屏名/屏数/圆盘所在角」变了才需要重新落几何与打日志。
        let key = "\(picked.source)|\(name)|\(count)|\(Int(circle.minX) / 100)|\(Int(circle.minY) / 100)"
        if key != lastPanelScreenKey {
            lastPanelScreenKey = key
            log("panel screen source=\(picked.source) name=\(name) screens=\(count) " +
                "circle=(\(Int(circle.minX)),\(Int(circle.minY)))")
        }
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
    /// 点横幅的唯一路径：鼠标点击（BannerView.onClick）与 `--banner-probe` 都调它。
    /// 日志契约（t14 用户要求）：`banner click kind=<session|run|approval|question> id=<短 id>`，
    /// 一次点击只消费这一条 —— 先 log、再 dismiss 该条、最后执行条目自己的动作。
    private func handleBannerClick(_ window: NSWindow) {
        let meta = bannerMeta[ObjectIdentifier(window)]
        let clickKind = meta?.kind ?? "-"
        let clickId = meta.map { shortId($0.id) } ?? "-"
        log("banner click kind=\(clickKind) id=\(clickId)")
        let action = bannerActions[ObjectIdentifier(window)]
        dismissBanner(window)
        action?()
    }

    @discardableResult
    private func showBanner(title: String, body: String,
                            bannerId: String? = nil, bannerKind: String? = nil,
                            onClick: (() -> Void)? = nil) -> NSWindow? {
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
        if let bannerId {
            bannerMeta[ObjectIdentifier(window)] = (bannerId, bannerKind ?? "run")
        }
        view.onClick = { [weak self, weak window] in
            guard let window else { return }
            self?.handleBannerClick(window)
        }
        if let onClick { bannerActions[ObjectIdentifier(window)] = onClick }
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
        // 停留分档（t4 §2.4-b + R-06 U-31）：
        //   待回答 = 60s（用户可能正在别的窗口，30s 太短会漏掉提问）
        //   待批准/完成类/失败类 = 30s（prd 2.24）
        //   不可点的纯提示 = 6s
        let lifetime: TimeInterval = bannerKind == "question" ? 60 : (onClick == nil ? 6 : 30)
        // U-31：**不用 asyncAfter 计时**。实测 `asyncAfter(.now()+60)` 在 accessory 应用里
        // 会被系统计时器合并推迟到 63.0s（30s 档同样飘到 30.9s），横幅寿命就没法验收。
        // 改为 0.5s 看门狗 + 墙钟比对：停留误差 ≤0.5s，且日志自带 elapsed 可复核。
        let deadline = Date().addingTimeInterval(lifetime)
        bannerShownAt[ObjectIdentifier(window)] = Date()
        bannerDeadlines[ObjectIdentifier(window)] = (deadline: deadline, lifetime: lifetime,
                                                     kind: bannerKind ?? "-", clickable: onClick != nil)
        startBannerWatchdog()
        return window
    }

    /// 关掉一条横幅并把剩下的整体上移一格（2.21：点最上面一条，下方上顶）。
    /// 条目被消费 → 对应横幅立刻消失（下一轮 2s 轮询内），不必等 30s 超时。
    /// 判据：横幅记住的 `id` 已不在 feed 的 items 里，也不在 `doneUnreadIds` 里
    /// （置读 / 终态被过滤 / hide-session / hidden-runs 都算「消费掉」）。
    private func pruneConsumedBanners() {
        guard !banners.isEmpty else { return }
        var live = Set<String>()
        for item in state.items { if let id = item.id { live.insert(id) } }
        for id in state.doneUnreadIds { live.insert(id) }
        for window in banners {
            guard let meta = bannerMeta[ObjectIdentifier(window)] else { continue }
            guard !live.contains(meta.id) else { continue }
            log("banner dismiss reason=item-consumed id=\(shortId(meta.id)) kind=\(meta.kind)")
            dismissBanner(window, reason: "item-consumed")
        }
    }

    /// U-31：0.5s 看门狗——按墙钟判断哪条横幅到期，到点才 dismiss。
    /// 这样即使主线程忙、系统合并计时器，停留也是「lifetime + ≤0.5s」，可验收。
    private func startBannerWatchdog() {
        guard bannerWatchdog == nil else { return }
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.reapExpiredBanners()
        }
        RunLoop.main.add(timer, forMode: .common)
        bannerWatchdog = timer
    }

    private func reapExpiredBanners() {
        if bannerDeadlines.isEmpty, banners.isEmpty {
            bannerWatchdog?.invalidate()
            bannerWatchdog = nil
            return
        }
        let now = Date()
        for window in banners {
            guard let entry = bannerDeadlines[ObjectIdentifier(window)] else { continue }
            guard now >= entry.deadline else { continue }
            let elapsed = now.timeIntervalSince(bannerShownAt[ObjectIdentifier(window)] ?? now)
            log(String(format: "banner timer kind=%@ lifetime=%.0fs elapsed=%.2fs",
                       entry.kind, entry.lifetime, elapsed))
            dismissBanner(window, reason: entry.clickable ? "expired" : "timeout")
        }
    }

    private func dismissBanner(_ window: NSWindow, reason: String = "clicked") {
        guard let index = banners.firstIndex(where: { $0 === window }) else { return }
        bannerShownAt.removeValue(forKey: ObjectIdentifier(window))
        bannerDeadlines.removeValue(forKey: ObjectIdentifier(window))
        let title = bannerTitles[ObjectIdentifier(window)] ?? "-"
        banners.remove(at: index)
        bannerTitles.removeValue(forKey: ObjectIdentifier(window))
        bannerMeta.removeValue(forKey: ObjectIdentifier(window))
        bannerActions.removeValue(forKey: ObjectIdentifier(window))
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
        components.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "id", value: ids.joined(separator: ","))])
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

    /// 呼吸光环：只决定「用哪种颜色呼吸」，动画由 Core Animation 自己跑。
    /// 旧实现用 20Hz Timer 触发整圆重绘（t5 M1 实测常驻 CPU 3.0%，门 1.0%），已删除。
    private func syncPulse() {
        let color: NSColor?
        if state.offline {
            color = nil
        } else if state.questions > 0 {
            color = .systemYellow
        } else if state.approvals > 0 {
            color = .systemRed
        } else if state.doneUnread > 0 {
            color = .systemGreen
        } else {
            color = nil
        }
        // 只有「要你动手」的两种状态才加外圈呼吸环：doneUnread 用实心环 + 呼吸点表达，
        // 再叠一层 halo 会和待批准的双环混淆（2026-11-18 截图 OCR 复验发现）。
        let halo = !state.offline && (state.questions > 0 || state.approvals > 0)
        circleView?.setPulse(active: halo,
                             color: color ?? .systemGreen,
                             morph: CircleBadgeView.morph(for: state))
        let key = "\(halo ? 1 : 0)/\(state.questions)/\(state.approvals)/\(state.doneUnread)"
        if key != lastPulseKey {
            lastPulseKey = key
            log("pulse state questions=\(state.questions) approvals=\(state.approvals) " +
                "doneUnread=\(state.doneUnread) halo=\(halo ? 1 : 0)")
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
        // t14：展开/收起会重设窗口 frame，旧 tracking area 会先发一次 mouseExited，
        // 于是「指针明明停在面板里」也被判成离开、面板当场收起。判据改成真的出了窗口才收。
        if rootHovered() {
            log("keep expand reason=cursor-inside")
            return
        }
        guard isExpanded, !options.forceExpanded else { return }
        // 从横幅点进来的详情/审批，鼠标本来就停在横幅上（面板外）。若按 hover 规则
        // 自动收起，用户会看到面板闪一下就没了。详情或待审批期间一律不自动收起。
        guard detailMode == .summary, pendingApprovalId == nil else { return }
        scheduleCollapse()
    }

    /// 现在允许收起吗（t14-4 ③）：指针在框外 **且** 距最近一次点击/滚轮 >800ms。
    /// 详情页/审批页本来就不靠悬停驱动，一律不自动收。
    private func collapseAllowedNow() -> Bool {
        guard isExpanded, !options.forceExpanded else { return false }
        guard detailMode == .summary, pendingApprovalId == nil else { return false }
        guard !rootHovered() else { return false }
        return Date().timeIntervalSince(lastInteractionDate) >= HUD.clickGrace
    }

    private func scheduleCollapse() {
        collapseTimer?.invalidate()
        let timer = Timer(timeInterval: HUD.collapseDelay, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.collapseTimer = nil
            // 每次判定都留一行：万一以后又「自己收起」，这行能直接看出当时指针在哪、窗口在哪。
            log("collapse tick expanded=\(self.isExpanded) " +
                "cursor=\(NSStringFromPoint(self.pointerLocation())) " +
                "window=\(self.window.map { NSStringFromRect($0.frame) } ?? "-") " +
                "hovered=\(self.rootHovered()) " +
                "sinceClick=\(String(format: "%.2f", Date().timeIntervalSince(self.lastInteractionDate)))")
            guard self.isExpanded, !self.options.forceExpanded else { return }
            guard self.detailMode == .summary, self.pendingApprovalId == nil else { return }
            // 宽限期到期：只有几何上真的不在窗口（面板 + 圆盘）里才收。
            if self.rootHovered() {
                log("keep expand reason=cursor-inside")
                return
            }
            // 刚点过（点击可能刚让面板变形）：宽限内继续等，别把「还没来得及移到新位置」当成离开。
            if Date().timeIntervalSince(self.lastInteractionDate) < HUD.clickGrace {
                log("collapse deferred reason=recent-click")
                self.scheduleCollapse()
                return
            }
            log("collapse reason=cursor-outside")
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

        noteInteraction()
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
        if !dragMoved, hypot(dx, dy) >= HUD.dragThreshold { dragMoved = true }
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
        case .failure, .sessionMenu:
            break
        case .summary:
            if abs(event.scrollingDeltaY) > 0.1 { noteInteraction() }
            let before = panelContent?.listScrollRow ?? 0
            // 把事件本身的属性也打出来：「只移动指针也翻页」时靠这行定位调用源。
            log("scroll event src=scrollWheel dy=\(event.scrollingDeltaY) " +
                "phase=\(event.phase.rawValue) momentum=\(event.momentumPhase.rawValue) " +
                "precise=\(event.hasPreciseScrollingDeltas ? 1 : 0) row=\(before)")
            panelContent?.scrollList(by: event.scrollingDeltaY)
            let after = panelContent?.listScrollRow ?? 0
            if before != after { log("list scroll row=\(after) src=scrollWheel") }
        case .approval, .children:
            break
        }
    }

    func handleMouseUp(_ event: NSEvent) {
        if event.timestamp - lastMouseUpTimestamp < 0.02 { return }
        lastMouseUpTimestamp = event.timestamp
        noteInteraction()
        log("mouseUp detail=\(detail != nil) mode=\(detailMode) dragMoved=\(dragMoved) isDragging=\(isDragging)")
        guard isDragging else { return }
        isDragging = false
        dragStartMouse = nil
        guard let window else { return }
        if dragMoved {
            let frame = window.frame.origin
            circleOrigin = isExpanded
                ? NSPoint(x: frame.x + circleInPanel.x, y: frame.y + circleInPanel.y)
                : anchorFromCapsule(window.frame)
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
                    case .freeAnswer(let index):
                        promptFreeAnswer(blockIndex: index)
                    case .answer(let index):
                        answerQuestion(optionIndex: index)
                    case .retryRun:
                        retryRun()
                    case .copyError:
                        copyErrorToPasteboard()
                    case .clearRun:
                        clearCurrentRun()
                    case .sessionHide:
                        hideCurrentSession()
                    case .sessionJump:
                        jumpFromSessionMenu()
                    case .sessionCancel:
                        log("session menu cancel")
                        closeDetail()
                    case .jumpSession:
                        log("jump session click target=\(detail?.jumpSessionId ?? "-") run=\(detail?.runId ?? "-")")
                        let target = detail?.jumpSessionId.isEmpty == false
                            ? (detail?.jumpSessionId ?? "")
                            : (detail?.runId ?? "")
                        closeDetail()
                        if !target.isEmpty {
                            // 先落 seen 再跳：跳走再回来那行必须已经消失（现场 bug）。
                            markSeen([target]) { [weak self] in
                                log("jump session after-seen target=\(self?.shortId(target) ?? "-")")
                                self?.jumpToSession(target)
                            }
                        }
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
                            // t12：子 agent 行只在主点击路径上**展示信息**（角色/标题/状态/token），
                            // 不跳转；要跳是次级动作（子详情页右下角「跳到会话」）。
                            log("child row info-only id=\(self.shortId(id))")
                            openChildDetail(id)
                        }
                    }
                }
            }
        } else if let row = rowHitByGeometry(event) {
            // 几何优先：draw 期间登记的命中区可能和视觉错位（本次 captain 真机点击全 no-op 的根因）。
            dispatchRowClick(row, event: event)
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
        } else if clearDoneHit(event) {
            log("click on clear-done button")
            clearDone()
        } else if doneStatsHit(event) {
            log("click on done-unread stats -> mark all")
            markAllSeen()
        } else {
            log("single click: no-op")
        }
        dragMoved = false
    }

    /// 命中「清除已完成」按钮（摘要页底部）。
    private func clearDoneHit(_ event: NSEvent) -> Bool {
        guard isExpanded, let panelContent else { return false }
        let local = panelContent.convert(event.locationInWindow, from: nil)
        return panelContent.clearDoneHit(at: local)
    }

    /// 所有派生路由共用这一个基址：feed 形如 `http://127.0.0.1:62044/x-radar/radar`
    /// （也可能是 `/x-radar-b/radar`）。去掉最后一段 `radar*`，剩下的前缀就是插件根。
    /// clear-done / jump / 回执都从这里拼，避免各自用正则拼出不同前缀（t14-1 的根因）。
    private func feedBaseComponents() -> URLComponents? {
        let raw = lastResolvedURLString.split(separator: "|").first.map(String.init) ?? ""
        guard var components = URLComponents(string: raw), components.host != nil else { return nil }
        var segments = components.path.split(separator: "/").map(String.init)
        if let last = segments.last, last.hasPrefix("radar") { segments.removeLast() }
        components.path = segments.isEmpty ? "" : "/" + segments.joined(separator: "/")
        components.queryItems = nil
        components.query = nil
        components.fragment = nil
        return components
    }

    /// 一键清除已完成：走插件 /x-radar/clear-done（标已读 + 清 finished 记账），幂等。
    private func clearDone() {
        guard var components = feedBaseComponents() else {
            log("clear-done: no resolved url last=\(lastResolvedURLString)")
            showBanner(title: "清除失败", body: "还没连上雷达服务")
            return
        }
        components.path = (components.path.isEmpty ? "" : components.path) + "/clear-done"
        guard let url = components.url else {
            log("clear-done: bad url path=\(components.path)")
            showBanner(title: "清除失败", body: "地址不完整")
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        request.httpMethod = "GET"
        log("clear-done request url=\(url.absoluteString)")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            DispatchQueue.main.async {
                guard let self else { return }
                // 打全：状态码 + 字节数 + 响应体。旧实现只打 body，body 为空时看不出是 404 还是没网。
                log("clear-done status=\(status) bytes=\(data?.count ?? 0) body=\(text.prefix(160))")
                if let error {
                    log("clear-done failed \(error.localizedDescription)")
                    self.showBanner(title: "清除没成功", body: "下次再试")
                    return
                }
                let okStatus = (200...299).contains(status)
                let okBody = !text.isEmpty && text.contains("\"ok\"") && !text.contains("\"ok\":false")
                guard okStatus, okBody else {
                    self.showBanner(title: "清除没成功", body: "服务返回 \(status)")
                    return
                }
                log("clear-done ok cleared=\(text.prefix(80))")
                self.panelContent?.resetListScroll()
                self.noteInteraction()
                self.fetchNow(reason: "clear-done")
            }
        }.resume()
    }

    /// 命中「待批准」行。
    // MARK: 宽胶囊（t4 §1.2）

    /// 当前是否该显示宽胶囊，以及画它需要的一切（文本已截断到文本盒 T 内）。
    private func pillContent() -> (text: String, accent: NSColor, glyph: String)? {
        guard !state.offline else { return nil }
        var prefix = ""
        var accent = NSColor.systemYellow
        var glyph = "?"
        var body: String?
        if state.questions > 0 {
            // U-54：多条待答时胶囊必须带计数，不能只显示第一条（用户看不出还有几问答没处理）。
            let pending = max(state.questions, state.questionItems.count)
            prefix = pending > 1 ? "等回答(\(pending))：" : "等回答："
            accent = HUD.questionColor
            glyph = "?"
            if let item = state.items.first(where: { $0.isQuestion }) {
                // 首题可能没有正文（占位/空串）：往下找第一道有正文的，并把序号告诉用户，
                // 绝不允许宽胶囊出现空的「等回答：」（用户口径 2026-11-19 第 3 条）。
                let asks = (item.questions ?? []).map { ($0.question ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
                if let index = asks.firstIndex(where: { !$0.isEmpty }) {
                    let text = asks[index]
                    if index == 0 {
                        body = text
                    } else {
                        prefix = "第 \(index + 1) 个问题："
                        body = text
                    }
                } else {
                    body = firstSentence(item.title ?? "")
                }
            }
            if firstSentence(body ?? "").isEmpty { body = "会话在等你回答" }
        } else if state.approvals > 0 {
            prefix = "要批准："
            accent = HUD.approvalColor
            glyph = "✓"
            if let item = state.items.first(where: { $0.isApproval }) {
                body = item.title ?? item.error
            }
        } else if state.blockedCount > 0 {
            // U-13：卡住（等用户决定）以前在胶囊里根本不存在，被当成 idle。
            prefix = "卡住："
            accent = HUD.blockedColor
            glyph = "!"
            if let item = state.items.first(where: { $0.status == "blocked" }) {
                body = item.title ?? item.error
            }
            if firstSentence(body ?? "").isEmpty { body = "有任务卡在等你决定" }
        } else if state.failed > 0 {
            prefix = "失败："
            accent = HUD.failedColor
            glyph = "×"
            if let item = state.items.first(where: { $0.isFailedRun || $0.status == "failed" }) {
                body = item.error ?? item.title
            }
        } else if state.reworkCount > 0 {
            // U-13：返工中（审查未通过）同样要能在胶囊上看见。
            prefix = "要改："
            accent = HUD.reworkColor
            glyph = ""
            if let item = state.items.first(where: { $0.status == "rework" }) {
                body = item.title ?? item.note ?? item.error
            }
            if firstSentence(body ?? "").isEmpty { body = "有任务需要返工" }
        } else {
            return nil
        }
        let first = firstSentence(body ?? "")
        var text = prefix + first
        let width = pillTextWidth(text)
        if width < HUD.pillTextMin, first.isEmpty {
            text = prefix
        }
        return (truncatePillText(text, limit: pillTextBoxWidth(text)), accent, glyph)
    }

    /// 状态前缀之后那句人话：按句末标点切第一段，最多 80 字（t4 §1.3-a）。
    private func firstSentence(_ raw: String) -> String {
        let collapsed = raw.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !collapsed.isEmpty else { return "" }
        let separators = CharacterSet(charactersIn: "。！？!?；;").union(CharacterSet(charactersIn: "\n"))
        if let range = collapsed.rangeOfCharacter(from: separators) {
            let head = String(collapsed[collapsed.startIndex..<range.lowerBound])
            if !head.isEmpty { return String(head.prefix(80)) }
        }
        return String(collapsed.prefix(80))
    }

    private var pillFont: NSFont {
        NSFont.systemFont(ofSize: HUD.pillFontSize, weight: .medium)
    }

    private func pillTextWidth(_ text: String) -> CGFloat {
        (text as NSString).size(withAttributes: [.font: pillFont]).width
    }

    /// 文本盒 T = clamp(实测宽, 112, 168)；整体宽 W = 66 + T，硬上限 240。
    private func pillTextBoxWidth(_ text: String, chromeWidth: CGFloat = HUD.pillChromeWidth) -> CGFloat {
        let measured = pillTextWidth(text)
        let box = min(HUD.pillTextMax, max(HUD.pillTextMin, measured))
        return min(box, HUD.pillMaxWidth - chromeWidth)
    }

    /// 字素二分：找最长的前缀 p 使 `p + "…"` 不超过 limit；没丢内容就不加省略号（t4 §1.3-c）。
    private func truncatePillText(_ text: String, limit: CGFloat) -> String {
        guard limit > 0 else { return "" }
        if pillTextWidth(text) <= limit { return text }
        var low = 0
        var high = text.count
        while low < high {
            let mid = (low + high + 1) / 2
            let candidate = String(text.prefix(mid)) + "…"
            if pillTextWidth(candidate) <= limit { low = mid } else { high = mid - 1 }
        }
        guard low > 0 else { return "…" }
        return String(text.prefix(low)) + "…"
    }

    /// 胶囊形状：宽态 44 高、W 由文本决定；圆态沿用 56×56。
    private func capsuleSize() -> NSSize {
        guard let pill = pillContent() else {
            return NSSize(width: HUD.circleSize, height: HUD.circleSize)
        }
        let box = pillTextBoxWidth(pill.text)
        return NSSize(width: HUD.pillChromeWidth + box, height: HUD.pillHeight)
    }

    /// 锚点（圆形态圆心）→ 窗口矩形。§1.5-b：右半屏右侧固定向左长，左半屏左侧固定向右长；
    /// 越出 visibleFrame±12 就翻转，仍越界则整体平移夹取。
    private func capsuleRect(size: NSSize, sizeBefore: NSSize? = nil) -> NSRect {
        let anchor = circleOrigin
        guard size.width > HUD.circleSize + 0.5 else {
            return NSRect(origin: anchor, size: NSSize(width: HUD.circleSize, height: HUD.circleSize))
        }
        let anchorRect = NSRect(origin: anchor, size: NSSize(width: HUD.circleSize, height: HUD.circleSize))
        let screen = self.screen(containing: anchorRect) ?? NSScreen.main
        let visible = (screen?.visibleFrame ?? anchorRect).insetBy(dx: HUD.edgeMargin, dy: HUD.edgeMargin)
        let center = NSPoint(x: anchorRect.midX, y: anchorRect.midY)
        var growLeft = center.x >= (screen?.visibleFrame.midX ?? center.x)
        func rect(growLeft: Bool) -> NSRect {
            let x = growLeft ? center.x + HUD.circleRadius - size.width : center.x - HUD.circleRadius
            return NSRect(x: x, y: center.y - size.height / 2, width: size.width, height: size.height)
        }
        var candidate = rect(growLeft: growLeft)
        if candidate.minX < visible.minX, !growLeft { growLeft = true; candidate = rect(growLeft: true) }
        if candidate.maxX > visible.maxX, growLeft { growLeft = false; candidate = rect(growLeft: false) }
        capsuleGrowLeft = growLeft
        let clampedX = min(max(candidate.minX, visible.minX), visible.maxX - candidate.width)
        let clampedY = min(max(candidate.minY, visible.minY), visible.maxY - candidate.height)
        return NSRect(x: clampedX, y: clampedY, width: candidate.width, height: candidate.height)
    }

    /// 窗口矩形 → 锚点（收起态拖拽/保存时用；宽胶囊的圆心要按生长方向反推）。
    private func anchorFromCapsule(_ frame: NSRect) -> NSPoint {
        guard frame.width > HUD.circleSize + 0.5 else { return frame.origin }
        let centerX = capsuleGrowLeft ? frame.maxX - HUD.circleRadius : frame.minX + HUD.circleRadius
        let centerY = frame.midY
        return NSPoint(x: centerX - HUD.circleRadius, y: centerY - HUD.circleRadius)
    }

    /// 宽胶囊的呼吸环：给 pill 用同样的「一圈」表达，几何随矩形走。
    private func syncPill() {
        guard let pillView else { return }
        if let pill = pillContent() {
            pillView.text = pill.text
            pillView.accent = pill.accent
            pillView.glyph = pill.glyph
            pillView.state = state
        }
    }

    /// 真机点击的落点诊断：把「换算后的窗口内坐标 / 视图内坐标 / 视图尺寸 / 可见行矩形」
    /// 一次打全，避免下次再靠猜（2026-11-18 的 no-op 复盘）。
    private func logClickGeometry(_ event: NSEvent, reason: String) {
        guard let panelContent else {
            log("click \(reason) panel=nil")
            return
        }
        let windowPoint = event.locationInWindow
        let local = panelContent.convert(windowPoint, from: nil)
        let frame = panelContent.frame
        log("click \(reason) win=(\(Int(windowPoint.x)),\(Int(windowPoint.y))) " +
            "local=(\(Int(local.x)),\(Int(local.y))) panelFrame=\(NSStringFromRect(frame)) " +
            "bounds=\(NSStringFromRect(panelContent.bounds)) " +
            "flipped=\(panelContent.isFlipped ? 1 : 0) " +
            panelContent.rowGeometryDump())
    }

    /// 按几何解析点击行，返回 (item, rect)；顺带打一行 `hit row=…` 证据。
    private func rowHitByGeometry(_ event: NSEvent) -> RadarItem? {
        guard isExpanded, let panelContent else { return nil }
        if isAnimatingFrame {
            // 展开/收起的 180ms 内命中区在变，明确记下来，别再让它表现为「神秘 no-op」。
            log("click ignored: frame animating")
            return nil
        }
        let local = panelContent.convert(event.locationInWindow, from: nil)
        guard let hit = panelContent.rowAt(local) else { return nil }
        guard let id = hit.id, let item = state.items.first(where: { $0.id == id }) else { return nil }
        log("hit row=\(hit.row) visible=\(hit.visibleIndex) id=\(id) " +
            "rect=\(NSStringFromRect(hit.rect)) local=(\(Int(local.x)),\(Int(local.y))) " +
            "kind=\(item.kind ?? "-") status=\(item.status ?? "-")")
        return item
    }

    /// 行点击分发：语义与旧的「按命中区类型分支」一致，但只依赖 item 本身。
    private func dispatchRowClick(_ item: RadarItem, event: NSEvent?) {
        // 双击会话行 = 问「要处理这个会话吗？」（仅在摘要页；双击后 300ms 内不再触发）。
        let clicks = event?.clickCount ?? 1
        if clicks >= 2, item.kind == "session" {
            let now = Date()
            if now.timeIntervalSince(lastSessionMenuAt) >= 0.3 {
                lastSessionMenuAt = now
                openSessionMenu(item)
                return
            }
            log("session menu double-click ignored (debounce)")
            return
        }
        if item.isApproval || item.isQuestion {
            openApproval((id: item.id ?? "", approvalId: item.approvalId ?? ""))
        } else if item.kind == "session" {
            // t12 跳转语义（用户 2026-11-19）：会话行**主点击就是跳回主会话**，
            // 子 agent 的会话窗口不是用户要去的地方。看详情是次级动作：按住 ⌥ 再点。
            // 已完成行先置读再跳（否则跳过去回来那行还在，现场 bug 2）。
            let optionHeld = event?.modifierFlags.contains(.option) ?? false
            if item.status == "done", let id = item.id {
                markSeen([id])
            }
            if optionHeld {
                log("session row open detail (option) id=\(self.shortId(item.id ?? ""))")
                openSessionDetail(item)
            } else {
                // t12：主点击一律跳回**顶层**会话。行上有父 id 就跳父；父 id 指向的会话
                // 已经不在列表里（被归档/回收）就跳自身，并留 jump parent-missing 证据。
                let selfId = item.id ?? ""
                let parentId = item.parentId ?? ""
                var target = selfId
                if !parentId.isEmpty {
                    if self.state.items.contains(where: { $0.id == parentId }) {
                        target = parentId
                    } else {
                        log("jump parent-missing id=\(self.shortId(selfId)) parent=\(self.shortId(parentId)) -> self")
                    }
                }
                log("jump session from-row id=\(self.shortId(target)) self=\(self.shortId(selfId)) kind=\(item.kind ?? "-") status=\(item.status ?? "-")")
                jumpToSession(target)
            }
        } else if let id = item.id, item.isArtifact, let path = item.path {
            openArtifact(path)
            _ = id
        } else if item.isFailedRun {
            // 失败之后要有下一步：动作页（重试 / 复制错误 / 清掉这条 / 事件流）。
            openFailureDetail(item)
        } else if let id = item.id, item.isDoneUnreadRun || item.isRunningRun || item.isReviewRun ||
                    item.isQuestion {
            openDetail(id)
        } else if let id = item.id {
            openDetail(id)
        } else {
            log("single click: row has no id")
        }
    }

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
        // 会话内提问被插件接管时才有回执通道（requestId + 一次性 token）。
        pendingAnswerRequest = item.answerRequest
        pendingAnswerToken = item.answerToken
        pendingAnswerQuestionId = (item.questions ?? []).first?.id
        pendingAnswerOptions = ((item.questions ?? []).first?.options ?? []).map(\.display)
        pendingAnswerMulti = (item.questions ?? []).first?.multiSelect == true
        pendingAnswerPicked = []
        detailMode = .approval
        detailLastSeq = 0
        let question = item.isQuestion
        var choices: [(questionId: String, label: String)] = []
        var blocks: [(id: String, text: String, options: [String], free: Bool,
                      degraded: Bool, multi: Bool)] = []
        // U-18：多问要一次提交，先把「问题顺序 + 每问题选项」固化下来。
        answerOrder = []
        answerSelections = [:]
        answerMulti = [:]
        answerOptions = [:]
        answerCustom = [:]
        answerSubmittedNotice = nil
        panelContent?.submittedNotice = nil
        if question {
            for (qi, ask) in (item.questions ?? []).enumerated() {
                let qid = ask.id ?? "q\(qi)"
                let labels = (ask.options ?? []).map(\.display)
                let text = (ask.question ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let header = (ask.header ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let body = text.isEmpty ? (header.isEmpty ? (item.title ?? "") : header) : text
                // U-40：无 options 不再给「自由回答」芯片（K3 未实现，给了就是谎报能力），
                // 改为「该问题只能到会话里回答」+「打开会话」。
                let degraded = labels.isEmpty
                let multi = ask.multiSelect == true
                blocks.append((id: qid, text: body, options: labels,
                               free: !degraded && pendingAnswerRequest == nil,
                               degraded: degraded, multi: multi))
                answerOrder.append(qid)
                answerMulti[qid] = multi
                answerOptions[qid] = labels
                for label in labels { choices.append((questionId: qid, label: label)) }
            }
        }
        // 多问或多选都需要一个显式的提交行（单问单选保持「点选即提交」）。
        let needsSubmitRow = question && pendingAnswerRequest != nil &&
            (answerOrder.count > 1 || answerMulti.values.contains(true))
        if needsSubmitRow {
            choices.append((questionId: answerOrder.first ?? "", label: Self.multiSubmitLabel))
        }
        panelContent?.questionChoices = choices
        panelContent?.questionBlocks = blocks
        panelContent?.questionPicked = [:]
        panelContent?.showsSubmitRow = needsSubmitRow
        panelContent?.isQuestionDetail = question
        panelContent?.questionIdFallback = (item.questions ?? []).first?.id
        detail = RadarDetail(
            title: "\((item.agent ?? "codex").uppercased()) " + (question ? "有问题要问你" : "请求批准"),
            agent: item.agent ?? "codex",
            meta: item.staleApproval == true
                ? "这条审批是宿主重启前留下的，已经没有进程在等它，可以直接忽略"
                : question
                    ? item.answerRequest != nil
                        ? ((item.questions ?? []).allSatisfy { ($0.options ?? []).isEmpty }
                            ? "等你回答 · 这条提问要自由文本，本次只能在 DSH 里回答"
                            : (pendingAnswerMulti
                                ? "等你回答 · 多选：点选项切换，点「\(Self.multiSubmitLabel)」发送；20s 没答自动回桌面卡"
                                : "等你回答 · 点一个选项即提交；20s 没答自动回桌面卡"))
                        : ((item.questions ?? []).allSatisfy { ($0.options ?? []).isEmpty }
                            ? "等你回答 · 这条提问要自由文本，点「✎ 回答…」输入后发送；不答超时按拒绝处理"
                            : "等你回答 · 选一个选项 = 回执该选项；不答超时按拒绝处理")
                    : "等你决定 · 5 分钟内不处理会自动拒绝",
            body: item.title ?? "",
            runId: item.id ?? "",
            live: false
        )
        // U-40：「打开会话」按钮要能真跳。提问条的 id 形如 `question:<sessionId>`，
        // 没有现成 jumpSessionId 字段，这里就地反推，绝不跳空。
        if question {
            let raw = item.id ?? ""
            let sid = raw.hasPrefix("question:") ? String(raw.dropFirst("question:".count)) : raw
            detail?.jumpSessionId = sid
        }
        panelContent?.detailMode = .approval
        panelContent?.detail = detail
        // N-06：点横幅（或列表行）后必须展开，否则「打开详情」是看不见的。
        if !isExpanded { setExpanded(true, animated: true) }
        // t5 点击→面板 p95<150ms：面板已展开时换页不做尺寸动画（180ms 动画会把 p50 顶到 ~180ms）。
        refreshExpandedGeometry(animated: false)
        log("approval open id=\(hit.approvalId.prefix(8)) expanded=\(isExpanded)")
    }

    /// 提问块内的「自由回答」：输入框弹窗里必须带问题原文（不是只有「请输入回答」）。
    private func promptFreeAnswer(blockIndex: Int) {
        guard let panelContent, panelContent.questionBlocks.indices.contains(blockIndex) else { return }
        let block = panelContent.questionBlocks[blockIndex]
        let qid = block.id.isEmpty ? "q\(blockIndex)" : block.id
        let head = block.text.count > 60 ? String(block.text.prefix(60)) + "…" : block.text
        inputFocused = true
        let text = promptText(title: "回答：\(head)",
                              message: block.text.isEmpty ? "（这个问题没有正文，请直接输入你的回答）" : block.text)
        inputFocused = false
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            log("free-answer cancelled qid=\(qid)")
            return
        }
        guard let request = pendingAnswerRequest, let token = pendingAnswerToken else {
            log("free-answer blocked: no receipt channel qid=\(qid)")
            _ = showBanner(title: "这条只能回 DSH 答", body: "胶囊没拿到回执通道（被接管才可答）", onClick: nil)
            return
        }
        log("free-answer submit qid=\(qid) len=\(text.count)")
        submitAnswer(request: request, token: token, questionId: qid, selected: [], custom: text)
    }

    /// N-10：自由文本提问的回答入口。
    ///
    /// 无 options 时不能给固定字符串：这里用带文本框的 NSAlert 让用户输入真实内容，
    /// 再按 `{questionId: text}` 回执（bridge 会包成 `{answers:{qid:{answers:[text]}}}`）。
    /// 多问题逐个输入；任何一次取消都整体放弃，绝不半提交。
    /// 边界：这是 HUD 内的轻量输入，不支持多行富文本；需要长答案请在会话里回答。
    private func promptAnswers() {
        if pendingAnswerRequest != nil {
            log("prompt blocked: dsh question is answered in place only")
            _ = showBanner(title: "这条要自由文本", body: "本次只能在 DSH 里回答", onClick: nil)
            return
        }
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
        // 插件接管了这条会话内提问：就地提交（单选点即发、多问/多选集齐后一次提交）。
        if pendingAnswerRequest != nil, pendingAnswerToken != nil {
            if choice.label == Self.multiSubmitLabel {
                submitAllAnswers()
                return
            }
            let bare = choice.label.hasPrefix("● ") ? String(choice.label.dropFirst(2)) : choice.label
            let qid = choice.questionId
            if answerMulti[qid] == true {
                var picked = answerSelections[qid] ?? []
                if picked.contains(bare) { picked.removeAll { $0 == bare } } else { picked.append(bare) }
                answerSelections[qid] = picked
                log("answer question qid=\(qid) picked=\(picked.joined(separator: ","))")
                refreshQuestionChoices()
                return
            }
            answerSelections[qid] = [bare]
            log("answer question qid=\(qid) selected=\(bare)")
            refreshQuestionChoices()
            // U-18：单问单选点选即提交；多问时答满最后一问就一次性提交全部答案。
            if allQuestionsAnswered() { submitAllAnswers() }
            return
        }
        decideApproval(approve: true, answers: [choice.questionId: choice.label])
    }

    /// 提交成功证据行：一条日志同时给出 via 通道、数组长度与停留时长（U-24 取证用）。
    private func logAnswerSubmitted(entries: Int) {
        log("[answer] submitted via=plugin-waterfall n=\(entries) notice=\(Self.submittedLabel) hold=1.5s")
    }

    /// 每一问都必须有选择（K2：避免把空的 selected 送回去，§3.3-c）。
    private func allQuestionsAnswered() -> Bool {
        for qid in answerOrder {
            if (answerSelections[qid] ?? []).isEmpty && (answerCustom[qid] ?? "").isEmpty { return false }
        }
        return !answerOrder.isEmpty
    }

    /// 一次提交全部答案：数组长度 == 问题数，顺序 = questions 原序（不排序）。
    private func submitAllAnswers() {
        guard let request = pendingAnswerRequest, let token = pendingAnswerToken else { return }
        let entries = answerOrder.compactMap { qid -> (id: String, selected: [String], custom: String?)? in
            let picked = answerSelections[qid] ?? []
            let custom = answerCustom[qid]
            guard !picked.isEmpty || !(custom ?? "").isEmpty else { return nil }
            return (id: qid, selected: picked, custom: custom)
        }
        guard entries.count == answerOrder.count else {
            let missing = answerOrder.count - entries.count
            log("answer submit blocked unanswered=\(missing) of \(answerOrder.count)")
            _ = showBanner(title: "还有 \(missing) 问没答", body: "每一问都要选一项才能提交", onClick: nil)
            return
        }
        submitAnswer(request: request, token: token, entries: entries)
    }

    /// 芯片/高亮/提交行统一重建：顺序必须与 drawQuestionPage 的绘制顺序一致
    /// （按 answerOrder 逐问、问内按 options 原序、最后是提交行），否则点击会错位。
    private func refreshQuestionChoices() {
        guard let panelContent else { return }
        var choices: [(questionId: String, label: String)] = []
        for qid in answerOrder {
            for label in (answerOptions[qid] ?? []) { choices.append((questionId: qid, label: label)) }
        }
        let needsSubmit = answerOrder.count > 1 || answerMulti.values.contains(true)
        if needsSubmit { choices.append((questionId: answerOrder.first ?? "", label: Self.multiSubmitLabel)) }
        panelContent.questionChoices = choices
        panelContent.questionPicked = answerSelections
        panelContent.showsSubmitRow = needsSubmit
        panelContent.needsDisplay = true
        let answered = answerOrder.filter { !(answerSelections[$0] ?? []).isEmpty }.count
        log("answer refreshed answered=\(answered)/\(answerOrder.count) chips=\(choices.count)")
    }

    /// 就地回执：GET `/x-radar/question-answer?request=…&token=…&answers=[{id,selected}]`。
    /// 形状由宿主裁定为数组（`{answers:[{id,selected,custom?}]}`），不是桥那套对象。
    private func submitAnswer(request: String, token: String,
                              questionId: String? = nil, selected: [String],
                              custom: String? = nil) {
        submitAnswer(request: request, token: token,
                     entries: [(id: questionId ?? pendingAnswerQuestionId ?? "q0",
                                selected: selected, custom: custom)])
    }

    /// U-18：一次提问的全部答案在一个数组里发出，顺序 = questions 原序（不排序）。
    private func submitAnswer(request: String, token: String,
                              entries: [(id: String, selected: [String], custom: String?)]) {
        let raw = lastResolvedURLString.split(separator: "|").first.map(String.init) ?? ""
        guard var components = URLComponents(string: raw), components.host != nil else { return }
        var segments = components.path.split(separator: "/").map(String.init)
        if let last = segments.last, last.hasPrefix("radar") {
            segments[segments.count - 1] = "question-answer"
        } else {
            segments.append("question-answer")
        }
        components.path = "/" + segments.joined(separator: "/")
        var answers: [[String: Any]] = []
        for entry in entries {
            var item: [String: Any] = ["id": entry.id, "selected": entry.selected]
            // 自由文本走 custom（t13 定稿回执形状：{answers:[{id,selected,custom}]}）。
            if let custom = entry.custom, !custom.isEmpty { item["custom"] = custom }
            answers.append(item)
            log("[answer] entry id=\(entry.id) selected=[\(entry.selected.joined(separator: ","))] " +
                "custom=\(entry.custom?.count ?? 0)")
        }
        guard let data = try? JSONSerialization.data(withJSONObject: answers),
              let json = String(data: data, encoding: .utf8) else { return }
        components.percentEncodedQueryItems = encodedQueryItems([
            URLQueryItem(name: "request", value: request),
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "answers", value: json),
        ])
        guard let url = components.url else { return }
        // R-06 U-24：转换点必须能证明「走的是插件 waterfall 通道、发的是数组形状」。
        log("[answer] submit request=\(request.prefix(8)) shape=array via=plugin-waterfall " +
            "n=\(entries.count) ids=\(entries.map(\.id).joined(separator: ","))")
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 4)
        req.httpMethod = "GET"
        URLSession.shared.dataTask(with: req) { [weak self] data, _, error in
            guard let self else { return }
            var ok = false
            if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                ok = (obj["ok"] as? Bool) == true
            }
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            DispatchQueue.main.async {
                if ok {
                    // U-24：芯片置灰 + 「已提交 · 不可撤回」停留（1.5s 规格，最少 0.6s），
                    // 之后才收页；这期间页面不再响应点击 = 不可撤回。
                    self.answerSubmittedNotice = Self.submittedLabel
                    self.panelContent?.submittedNotice = Self.submittedLabel
                    self.panelContent?.needsDisplay = true
                    self.logAnswerSubmitted(entries: entries.count)
                    self.pendingAnswerRequest = nil
                    self.pendingAnswerToken = nil
                    self.answerSelections = [:]
                    self.answerCustom = [:]
                    self.fetchNow(reason: "answer-submitted")
                    _ = self.showBanner(title: "已提交", body: "AI 收到答案了", onClick: nil)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        self.answerSubmittedNotice = nil
                        self.panelContent?.submittedNotice = nil
                        self.closeDetail()
                    }
                } else {
                    log("[answer] submit failed error=\(error?.localizedDescription ?? "-") body=\(text.prefix(160))")
                    // 条目已经不在服务端（20s 让渡/已在别处答过）时同样本地收页，别把用户锁在输入页。
                    if text.contains("not pending") || text.contains("bad token") {
                        log("close local reason=answer-not-pending status=\(String(text.prefix(80)))")
                        self.pendingAnswerRequest = nil
                        self.pendingAnswerToken = nil
                        self.closeDetail()
                    }
                    let note = text.contains("not pending")
                        ? "这条提问已经交回桌面卡（20s 超时或已答过），去 DSH 里答"
                        : text.contains("bad token") ? "回执凭据失效，回 DSH 里答" : "提交没成功，去 DSH 里答"
                    _ = self.showBanner(title: "没提交成功", body: note, onClick: nil)
                }
            }
        }.resume()
    }

    private func decideApproval(approve: Bool, answers: [String: String]? = nil) {
        guard let approvalId = pendingApprovalId else { return }
        // 会话内提问（feed 里 source=dsh）没有桥审批对象：面板只能展示，回执必须回到 DSH 界面。
        // 不拦的话点「回答/批准」会拿 question:<sessionId> 去打 approval-decide → 桥 404 → 假失败。
        if approvalId.hasPrefix("question:") {
            log("decide blocked: dsh question has no bridge approval id=\(approvalId)")
            _ = showBanner(title: "回 DSH 里回答", body: "胶囊暂时只能提醒；回执要在会话里提交", onClick: nil)
            return
        }
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
        components.percentEncodedQueryItems = encodedQueryItems(items)
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
                    // 服务端没确认时**也必须能退出这一页**（用户现场：点「取消」没反应，胶囊一直展开在桌面）。
                    // 语义不变：不清服务端状态、不假装成功；只把本地态回到列表，并如实说明。
                    let status = (text.isEmpty ? "no-body" : String(text.prefix(80)))
                    log("close local reason=decide-failed decision=\(decision) status=\(status)")
                    self.pendingApprovalId = nil
                    self.pendingApprovalToken = nil
                    self.pendingAnswerRequest = nil
                    self.pendingAnswerToken = nil
                    self.pendingQuestions = []
                    self.closeDetail()
                    self.showBanner(title: "服务端未确认，已本地关闭",
                                    body: "这条审批可能已经失效；详情已收起，可刷新再看", onClick: nil)
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
    private var clientHalfStaleShown = false
    private var clientHalfReloadHintShown = false

    /// prd 2.22：宿主起来 30s 还没收到 client.apply beacon 时，一次性提示「跳转需重载页面」。
    private func notifyClientHalf() {
        guard let half = clientHalf else { return }
        // 已经明确报告「页面加载的是旧 bundle」→ 优先按 reload 处理（自愈在页面侧，HUD 只负责说清楚）。
        if half.reload == true, !clientHalfReloadHintShown {
            clientHalfReloadHintShown = true
            _ = showBanner(title: "页面需刷新", body: "胶囊检测到页面还是旧版本，刷新后跳转恢复（会自动重试）")
            log("banner client-half reload host=\(half.hostBuild ?? "-") page=\(half.build ?? "-")")
            return
        }
        if half.active == true { clientHalfStaleShown = false; return }
        // 只对「真的超过 60 秒没 beacon」提示一次：短暂轮询抖动不该打扰用户。
        let ageMs = half.ageMs ?? Double.greatestFiniteMagnitude
        // Double→Int 越界会直接 trap（greatestFiniteMagnitude 就是越界值），日志里只接受有限值。
        let ageText = (ageMs.isFinite && ageMs < 1e15) ? String(Int(ageMs)) : "unknown"
        guard ageMs > 60_000 else { return }
        guard !clientHalfStaleShown else { return }
        clientHalfStaleShown = true
        // 快速短暂提示（4 秒自动消失），不抢焦点、不重复打扰。
        _ = showBanner(title: "跳转需刷新页面", body: half.hint ?? "页面里的雷达 client 半边没在轮询")
        log("banner client-half stale ageMs=\(ageText) lastBeacon=\(half.lastBeacon ?? "never")")
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
        components.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "session", value: sessionId)])
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
        components.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "id", value: id)])
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
        // 与 clear-done / 回执共用同一基址（t14-1：各拼各的会拼出 404）。
        guard var components = feedBaseComponents() else {
            log("jump: no resolved url")
            return
        }
        components.path = (components.path.isEmpty ? "" : components.path) + "/jump"
        components.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "session", value: sessionId)])
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
        // F-01：路径里带 `&` / `+` 时，手拼 query 会被服务端当分隔符/空格切开（找不到产物）。
        components.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "path", value: path)])
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

    /// 统一相对时间文案（用户 2026-11-19 要求）：
    /// 刚刚 / N 分钟前 / N 小时前 / N 天前，超过 30 天给日期（MM-dd）。
    /// 禁止出现负数与「0 小时」这类噪声。
    private func relativeTime(_ ms: Double, now: Double) -> String {
        guard ms > 0, ms.isFinite else { return "刚刚" }
        let diff = now - ms
        if !diff.isFinite || diff < 60_000 { return "刚刚" }
        let minutes = Int(diff / 60_000)
        if minutes < 60 { return "\(minutes) 分钟前" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) 小时前" }
        let days = hours / 24
        if days <= 30 { return "\(days) 天前" }
        return dateText(ms)
    }

    /// MM-dd（跨年再补年份）；时区跟系统。
    private func dateText(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let formatter = DateFormatter()
        let sameYear = Calendar.current.component(.year, from: date)
            == Calendar.current.component(.year, from: Date())
        formatter.dateFormat = sameYear ? "MM-dd" : "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    /// 可解释的「本次任务耗时」：只有观察窗口内的差值（>0 且 ≤6 小时）才算，
    /// 否则历史会话会算出「3000 小时」这种噪声（startedAt 是首次观察时间，不是任务开始时间）。
    private func plausibleDuration(started: Double?, finished: Double?) -> Double? {
        guard let started, let finished, started > 0, finished > started else { return nil }
        let span = finished - started
        guard span <= 6 * 60 * 60 * 1000 else { return nil }
        return span
    }

    /// 会话行点开先给一张「这次任务做得怎么样」的卡片，而不是直接跳走。
    private func openSessionCard(_ item: RadarItem) {
        let running = item.isRunningSession
        var body: [String] = []
        // 注意：RadarItem.startedAt / finishedAt 由 seconds(_:_:) 解码，单位是**秒**；
        // 这里统一换成毫秒再用，否则和 now（毫秒）相减会得到几亿秒 → 「几千小时」「1970-01-22」。
        let nowMs = Date().timeIntervalSince1970 * 1000
        let startedMs = (item.startedAt ?? 0) > 0 ? (item.startedAt! * 1000) : nil
        let finishedMs = (item.finishedAt ?? 0) > 0 ? (item.finishedAt! * 1000) : nil
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
            if let started = startedMs, nowMs - started <= 6 * 60 * 60 * 1000 {
                body.append("状态：进行中 · 已运行 \(humanDuration(nowMs - started))")
            } else {
                body.append("状态：进行中")
            }
            let touchedMs = Double(item.updatedAt ?? 0) > 0 ? Double(item.updatedAt!) : nil
            if let touchedMs, nowMs - touchedMs < 365.0 * 24 * 3600 * 1000 {
                body.append("最近活动：\(relativeTime(touchedMs, now: nowMs))")
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
            // 完成态不再用「已运行」：只给一句话结论 + 完成于 <相对时间>；
            // 耗时只在可解释窗口内（≤6 小时）才追加，避免「耗时 3000+ 小时」。
            var statusLine = "状态：已完成"
            if let note = item.note, !note.isEmpty { statusLine += "（\(note)）" }
            if let span = plausibleDuration(started: startedMs, finished: finishedMs) {
                statusLine += " · 耗时 \(humanDuration(span))"
            }
            body.append(statusLine)
            if let finishedMs {
                body.append("完成于：\(relativeTime(finishedMs, now: nowMs))")
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
        // 规则 A：摘要卡同样带跳转目标（已完成的会话也能跳）。
        card.jumpSessionId = sessionId
        detail = card
        detailOpenedAt = Date()
        detailMode = .summary
        panelContent?.detailMode = .summary
        refreshExpandedGeometry(animated: false)
    }

    /// 任何会话行（进行中/已完成/待回答/待批准/失败）点开都进「会话详情」：
    /// 正文列子会话，右下角「跳到会话」跳主会话。已完成的会话同样可以跳（规则 A）。
    private func openSessionDetail(_ item: RadarItem) {
        let kids = item.children ?? []
        if kids.isEmpty {
            // 没有子会话：用原来的会话摘要卡，但同样带上跳转目标。
            openSessionCard(item)
            return
        }
        var detail = RadarDetail(title: item.title ?? "会话", agent: item.agent ?? "dsh",
                                 meta: "\(kids.count) 个子会话", body: "")
        detail.parentId = item.id ?? ""
        detail.children = kids
        detail.isSession = true
        detail.jumpSessionId = item.id ?? ""
        detail.runId = item.id ?? ""
        self.detail = detail
        detailMode = .children
        detailOpenedAt = Date()
        panelContent?.detail = detail
        panelContent?.detailMode = .children
        if !isExpanded { setExpanded(true, animated: true) }
        refreshExpandedGeometry(animated: false)
        if let id = item.id, state.doneUnreadIds.contains(id), !(item.seen ?? false) {
            markSeen([id])
        }
        log("session detail open parent=\(item.id ?? "-") children=\(kids.count) status=\(item.status ?? "-")")
    }

    /// 子会话详情页：同一套列表页，但跳转目标是这条子会话。
    private func openChildDetail(_ id: String) {
        let parent = detail
        let child = parent?.children.first { $0.id == id }
        var next = RadarDetail(title: child?.displayTitle ?? "子会话",
                               agent: child?.agent ?? "dsh",
                               meta: child.map { $0.isRunning ? "进行中" : "已结束" } ?? "",
                               body: "")
        next.isSession = true
        next.jumpSessionId = id
        next.runId = id
        next.parentId = parent?.parentId ?? ""
        next.children = []
        detail = next
        detailMode = .children
        detailOpenedAt = Date()
        panelContent?.detail = next
        panelContent?.detailMode = .children
        refreshExpandedGeometry(animated: false)
        log("child detail open id=\(id) title=\(child?.displayTitle ?? "-")")
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
        refreshExpandedGeometry(animated: false)
        log("children open count=\(kids.count) parent=\(item.id ?? "-")")
    }

    /// 失败 run：动作页（重试 / 复制错误 / 清掉这条 / 事件流）。
    private func openFailureDetail(_ item: RadarItem) {
        openDetail(item.id ?? "", mode: .failure)
    }

    /// 双击会话行：HUD 内确认卡。
    private func openSessionMenu(_ item: RadarItem) {
        let sessionId = item.id ?? ""
        log("session menu open id=\(shortId(sessionId)) title=\(item.title ?? "-")")
        detailOpenedAt = Date()
        detailLastSeq = 0
        detail = RadarDetail(title: item.title ?? "（无标题）",
                             agent: item.agent ?? "dsh",
                             meta: "会话 \(shortId(sessionId))",
                             body: "",
                             runId: sessionId)
        panelContent?.detail = detail
        detailMode = .sessionMenu
        panelContent?.detailMode = .sessionMenu
        if !isExpanded { setExpanded(true, animated: true) }
        refreshExpandedGeometry(animated: false)
    }

    private func openDetail(_ id: String, mode: DetailMode = .summary) {
        guard let item = state.items.first(where: { $0.id == id }) else { return }
        log("open detail \(id) mode=\(mode)")
        detailForcedMode = mode
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
        refreshExpandedGeometry(animated: false)
        if item.isDoneUnreadRun, !(item.seen ?? false) {
            markSeen([id])
        }
        if item.isReviewRun {
            fetchVerdict(runId: id)
        }
        if mode == .failure {
            detailMode = .failure
            panelContent?.detailMode = .failure
        } else {
            detailForcedMode = nil
        }
        fetchRunDetail(id: id, title: item.title ?? "（无标题）", agent: item.agent ?? "unknown")
    }

    /// 失败页「重试」：让插件用同一 prompt/agent/cwd 重发，再刷新列表。
    private func retryRun() {
        guard let detail, !detail.runId.isEmpty else { return }
        guard let components = feedBaseComponents() else {
            showBanner(title: "重试没成功", body: "拿不到雷达地址")
            return
        }
        var target = components
        target.path += "/retry"
        target.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "run", value: detail.runId)])
        guard let url = target.url else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        request.httpMethod = "GET"
        log("retry request run=\(shortId(detail.runId)) url=\(url.absoluteString)")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            DispatchQueue.main.async {
                guard let self else { return }
                if error == nil, (200...299).contains(status), text.contains("\"ok\":true") {
                    log("retry ok run=\(self.shortId(self.detail?.runId ?? "-")) body=\(text.prefix(120))")
                    self.closeDetail()
                    self.fetchNow(reason: "retry")
                    self.showBanner(title: "已重试", body: "新任务已排队，稍后看列表")
                } else {
                    log("retry failed status=\(status) body=\(text.prefix(160))")
                    self.showBanner(title: "重试没成功", body: text.isEmpty ? "服务返回 \(status)" : String(text.prefix(60)))
                }
            }
        }.resume()
    }

    /// 失败页「复制错误」：完整错误进剪贴板（面板里只显示截断版）。
    private func copyErrorToPasteboard() {
        guard let detail else { return }
        let text = detail.body.isEmpty ? (state.items.first { $0.id == detail.runId }?.error ?? "") : detail.body
        guard !text.isEmpty else {
            showBanner(title: "没有可复制的错误", body: "这条任务没有留下错误文本")
            return
        }
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(text, forType: .string)
        log("copy error run=\(shortId(detail.runId)) chars=\(text.count)")
        showBanner(title: "错误已复制", body: "粘贴到 DSH 里就能追问")
    }

    /// 失败页「清掉这条」：标已读并从列表移除，磁盘上的 run 记录不动。
    private func clearCurrentRun() {
        guard let detail, !detail.runId.isEmpty else { return }
        log("clear run \(shortId(detail.runId))")
        markSeen([detail.runId])
        closeDetail()
        fetchNow(reason: "clear-run")
    }

    /// 会话确认卡「仅从雷达移除」：写 hidden-sessions.json + seen，feed 永久过滤。
    private func hideCurrentSession() {
        guard let detail, !detail.runId.isEmpty else { return }
        guard let components = feedBaseComponents() else {
            showBanner(title: "移除没成功", body: "拿不到雷达地址")
            return
        }
        var target = components
        target.path += "/hide-session"
        target.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "session", value: detail.runId)])
        guard let url = target.url else { return }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpMethod = "GET"
        log("hide session request id=\(shortId(detail.runId)) url=\(url.absoluteString)")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            DispatchQueue.main.async {
                guard let self else { return }
                if error == nil, (200...299).contains(status), text.contains("\"ok\":true") {
                    log("hide session ok id=\(self.shortId(self.detail?.runId ?? "-"))")
                    self.closeDetail()
                    self.fetchNow(reason: "hide-session")
                    self.showBanner(title: "已从雷达移除", body: "DSH 里的会话数据没动")
                } else {
                    log("hide session failed status=\(status) body=\(text.prefix(160))")
                    self.showBanner(title: "移除没成功", body: text.isEmpty ? "服务返回 \(status)" : String(text.prefix(60)))
                }
            }
        }.resume()
    }

    /// 会话确认卡「跳到 DSH 里删除」：只跳转，删不删由 DSH 本体决定（不代用户删数据）。
    /// 先写 seen 再跳：否则用户回来那行还挂着（现场 bug）。
    private func jumpFromSessionMenu() {
        guard let detail, !detail.runId.isEmpty else { return }
        let target = detail.runId
        log("session menu jump id=\(shortId(target))")
        closeDetail()
        markSeen([target]) { [weak self] in
            log("session menu jump after-seen id=\(self?.shortId(target) ?? "-")")
            self?.jumpToSession(target)
        }
    }

    /// 摘要 → 事件流。
    private func showEvents() {
        guard let detail else { return }
        detailMode = .events
        panelContent?.detailMode = .events
        refreshExpandedGeometry(animated: false)
        if detail.live { startLiveDetail() }
        log("detail -> events count=\(detail.events.count)")
    }

    /// 事件流 → 摘要。
    private func backToSummary() {
        stopLiveDetail()
        detailMode = .summary
        panelContent?.detailMode = .summary
        refreshExpandedGeometry(animated: false)
        log("detail -> summary")
    }

    /// 详情态对账（用户口径 2026-11-19 第 4 条）：在 DSH 页面把提问答掉之后，
    /// 条目会从 feed 里消失，但 HUD 不能继续停在「✕ 取消 / ✎ 回答」页。
    /// 只在「当前条目确实不再需要处置」时关；正在输入（inputFocused）时不动。
    private func reconcileOpenDetail() {
        guard detail != nil, !inputFocused else { return }
        let id = detail?.runId ?? ""
        guard !id.isEmpty else { return }
        switch detailMode {
        case .approval:
            let stillNeeds = state.items.contains { $0.id == id && ($0.isQuestion || $0.isApproval) }
            if !stillNeeds {
                log("detail auto-close reason=item-gone id=\(id)")
                pendingAnswerRequest = nil
                pendingAnswerToken = nil
                pendingApprovalId = nil
                closeDetail()
                log("capsule form=circle reason=resolved")
                refreshCapsuleGeometry(reason: "resolved")
            }
        case .failure:
            let stillFailed = state.items.contains { $0.id == id && ($0.isFailedRun || $0.status == "failed") }
            if !stillFailed {
                log("detail auto-close reason=item-gone id=\(id)")
                closeDetail()
            }
        default:
            break
        }
    }

    private func closeDetail() {
        guard detail != nil else { return }
        stopLiveDetail()
        log("close detail")
        detail = nil
        detailMode = .summary
        panelContent?.detail = nil
        panelContent?.detailMode = .summary
        refreshExpandedGeometry(animated: false)
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
        comps.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "run", value: runId)])
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
            components.percentEncodedQueryItems = encodedQueryItems([
                URLQueryItem(name: "since", value: String(detailLastSeq)),
                URLQueryItem(name: "limit", value: "500"),
            ])
        } else {
            components.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "limit", value: "2000")])
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
                // 失败页不能是空白：没有事件/正文时给一句明确解释，动作按钮照常可用。
                if self.detailMode == .failure, current.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    current.body = "没有可展示的事件（可能是历史 run）；可以从下面重试、复制错误或清掉这条。"
                }
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
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
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
        components.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "limit", value: "1")])
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

    /// 详情页 meta 的顺序（用户 2026-11-19 要求）：状态/完成时间在前，token 与事件数退到后面。
    /// 时间一律走「刚刚 / N 分钟前 / N 小时前 / N 天前 / MM-dd」，不出现负数或「0 小时」。
    private func metaText(run: [String: Any], status: String) -> String {
        var parts: [String] = []
        let now = Date().timeIntervalSince1970 * 1000
        var finishedAt = (run["finishedAt"] as? Double) ?? Double(run["finishedAt"] as? Int ?? 0)
        let startedAt = (run["startedAt"] as? Double) ?? Double(run["startedAt"] as? Int ?? 0)
        if finishedAt <= 0, let iso = run["updatedAt"] as? String,
           let date = ISO8601DateFormatter().date(from: iso) {
            finishedAt = date.timeIntervalSince1970 * 1000
        }
        // 桥 meta 的时间都是毫秒（或 ISO 字符串）；如果拿到的是「秒」量级，先放大到毫秒。
        if finishedAt > 0, finishedAt < 4_000_000_000 { finishedAt *= 1000 }
        var startedMs = startedAt
        if startedMs > 0, startedMs < 4_000_000_000 { startedMs *= 1000 }
        let liveStatus = (status == "running" || status == "starting" || status == "queued")
        parts.append(liveStatus ? "进行中" : (status == "failed" ? "失败" : "已完成"))
        if !liveStatus, finishedAt > 0 {
            parts.append("完成于 \(relativeTime(finishedAt, now: now))")
        }
        if let span = plausibleDuration(started: startedMs, finished: finishedAt) {
            parts.append("耗时 \(humanDuration(span))")
        } else if let duration = run["durationMs"] as? Int, duration > 0, duration <= 6 * 60 * 60 * 1000 {
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
        if status == "running", (run["pidAlive"] as? Bool) == false {
            parts.append("进程已退出")
        }
        // 失败详情给全量错误（feed 只给 200 字首句）。
        if status == "failed", let error = run["error"] as? String,
           !error.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.insert("失败：\(String(error.prefix(160)))", at: 0)
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
        refreshExpandedGeometry(animated: false)
        log("raw open seq=\(line.seq) lines=\(current.rawLines.count)")
    }

    private func backToEvents() {
        detailMode = .events
        panelContent?.detailMode = .events
        refreshExpandedGeometry(animated: false)
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
        components.percentEncodedQueryItems = encodedQueryItems([URLQueryItem(name: "id", value: ids.joined(separator: ","))])
        return components.url
    }

    /// 把这些外部 agent 结果标为已读：HUD 是只读轮询方，所以只发一次 GET，然后立刻重拉 feed。
    ///
    /// 用户现场（2026-11-19）：点「已完成」会话行后跳走，回来那行还在——写入根本没落地却没人知道。
    /// 现在必须读回执自证：`ok/verified` 为真才打 `markSeen ok`，否则 `markSeen failed` + 横幅，
    /// 并支持 `then` 串后续动作（「先写 seen 再跳」）。
    private func markSeen(_ ids: [String], then: (() -> Void)? = nil) {
        let valid = ids.filter { !$0.isEmpty }
        guard !valid.isEmpty, let url = seenEndpoint(ids: valid) else {
            log("markSeen failed id=\(ids.joined(separator: ",")) reason=no-endpoint")
            then?()
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                var ok = false
                var missing: [String] = []
                if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    ok = (obj["ok"] as? Bool) == true && (obj["verified"] as? Bool) == true
                    missing = (obj["missing"] as? [String]) ?? []
                }
                if ok {
                    log("markSeen ok id=\(valid.prefix(3).joined(separator: ",")) n=\(valid.count)")
                } else if let error {
                    log("markSeen failed id=\(valid.prefix(3).joined(separator: ",")) error=\(error.localizedDescription)")
                    self.showBanner(title: "标记已读没生效", body: "服务端没确认；这条还会留在列表里", onClick: nil)
                } else {
                    let http = (response as? HTTPURLResponse)?.statusCode ?? -1
                    log("markSeen failed id=\(valid.prefix(3).joined(separator: ",")) status=\(http) missing=\(missing.prefix(3).joined(separator: ",")) body=\(text.prefix(120))")
                    self.showBanner(title: "标记已读没生效", body: "服务端没确认；这条还会留在列表里", onClick: nil)
                }
                then?()
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
