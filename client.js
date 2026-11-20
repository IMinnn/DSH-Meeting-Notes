/**
 * Browser half of the meeting-notes plugin.
 *
 * A focused rewrite of dsh-meeting-room (by 杨道泉, 博尔塔拉融媒体中心媒体传播与认知重点实验室):
 * one "会议记录" chip under the composer starts recording and opens a record dialog
 * (in the style of Doubao / Feishu meeting notes); the live transcript, the merged
 * points & assignments list and the minutes all live in that dialog. Handwriting,
 * meeting kinds, periodic scribe loops, push robots and scoring were removed.
 *
 * Loaded through the client module table, so it must be a lazy CommonJS factory and
 * may `require` only the shared platform modules.
 *
 * Capture: microphone → inline AudioWorklet → 16 kHz mono PCM16 → cues endpointed at
 * pauses → same-origin HTTP → local SenseVoice. The terminology list fixes what the
 * local model reliably gets wrong, and composes a correction request for the agent.
 */
window.__ModuleLoader__.load({
  id: 'dsh-meeting-notes',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace owned by this plugin. */
    const NS = 'meetingNotes'

    /** Route prefix owned by the host half. */
    const PREFIX = '/meeting-notes'

    /** Browser-storage key holding the terminology list between meetings. */
    const TERMS_KEY = 'dsh-meeting-notes.terms'

    /** Target sample rate for the speech provider. */
    const TARGET_RATE = 16000

    /**
     * Adaptive endpointing, the way mainstream meeting recorders (豆包 / 通义听悟 and
     * peers) cut a cue: the noise floor is tracked live — a noisy room raises it, a
     * quiet one lowers it — speech is decided with hysteresis against that floor, and a
     * cue ends when the speaker really paused. Nothing here is configurable: the room
     * configures it, per meeting, by itself.
     */
    const VAD = {
      /** Believed noise floor bounds, so a glitch cannot poison the tracker. */
      floorMin: 0.0015,
      floorMax: 0.05,
      /**
       * How fast the floor may rise toward a louder room (a fraction per block) — and
       * ONLY while the block is not latched as speech: continuous music or a long
       * monologue must never raise the bar against itself, or the endpointer goes
       * quiet exactly while sound keeps playing.
       */
      floorRise: 0.004,
      /** Speech starts above floor × enterFactor… */
      enterFactor: 3.0,
      enterMin: 0.005,
      /** …and ends below floor × exitFactor — hysteresis keeps half-loud tails in speech. */
      exitFactor: 2.0,
      exitMin: 0.0035,
      /** Voiced audio a cue must hold before it is worth recognizing. */
      minSpeechSeconds: 0.15,
      /**
       * Trailing silence that ends a cue. 1.1 s, the mainstream recorders' paragraph
       * feel (腾讯会议 and peers): the pause between two sentences of ONE thought is
       * breath, not a boundary — cutting there used to shred a turn into cue-sized
       * scraps and starved the speaker model of the longer window it needs. The live
       * partial line keeps text on screen while the cue stays open, so nothing feels
       * slower.
       */
      endpointSilence: 1.1,
      /** Once a cue has run long, a shorter pause is allowed to end it. */
      softMaxCueSeconds: 4,
      shortEndpointSilence: 0.5,
      // ASR windows are NOT display paragraphs. Keep inference bounded; the host
      // assembles short windows into speaker paragraphs independently in the background.
      maxCueSeconds: 6,
    }

    /**
     * Live partial recognition — the “边说边出字” the mainstream recorders show:
     * while a cue is still open, its growing buffer is transcribed every few
     * hundred milliseconds and displayed as a ghost line; the settled /chunk for
     * the same cue replaces it (and, seeing the full utterance plus its clean
     * endpoint, frequently reads it differently — the visible “自动纠错”).
     * Purely a display enhancement: nothing partial is ever stored.
     */
    const PARTIAL = {
      /** Audio a cue must hold before its first partial is worth a model call. Kept
       * low on purpose: right after a settled block lands, the NEXT line of speech
       * must start typing again within half a second, or the transcript reads as
       * stalling at every paragraph break. */
      minSeconds: 0.5,
      /** Fresh audio between partial calls — fast enough that the ghost line keeps
       * flowing through a paragraph commit, spaced enough that one transcription is
       * never queued behind the last. */
      everySeconds: 0.5,
    }

    /**
     * Worklet source, installed from a Blob URL so the client bundle needs no asset.
     * It accumulates render quanta and posts ~128 ms blocks to keep messaging cheap.
     */
    const WORKLET_SOURCE = `
class MeetingCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i]
        if (this.filled === this.buffer.length) {
          this.port.postMessage(this.buffer.slice(0))
          this.filled = 0
        }
      }
    }
    return true
  }
}
registerProcessor('meeting-notes-capture', MeetingCapture)

// The far side of an online meeting arrives from the host's native capture as
// Float32 chunks: this processor turns that queue into a continuous audio source
// so it mixes into the same graph (and the same cues) as the microphone.
class MeetingInject extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.offset = 0
    this.port.onmessage = (event) => {
      if (this.queue.length > 400) this.queue.shift()
      this.queue.push(new Float32Array(event.data))
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0]
    if (!out) return true
    let filled = 0
    while (filled < out.length && this.queue.length > 0) {
      const chunk = this.queue[0]
      const take = Math.min(chunk.length - this.offset, out.length - filled)
      out.set(chunk.subarray(this.offset, this.offset + take), filled)
      filled += take
      this.offset += take
      if (this.offset >= chunk.length) {
        this.queue.shift()
        this.offset = 0
      }
    }
    for (; filled < out.length; filled++) out[filled] = 0
    return true
  }
}
registerProcessor('meeting-notes-inject', MeetingInject)
`

    // ── Locale ────────────────────────────────────────────────────────────────

    const zh = {
      open: '会议记录',
      openHint: '打开会议记录窗口',
      panelLabel: '会议记录',
      launcherHint: '会议记录窗口应已弹出；若没有，点下面按钮重新打开。',
      notesTitle: '笔记',
      notesExpand: '展开笔记',
      notesCollapse: '收起笔记',
      notesPlaceholder: '记录要点，DSH将结合生成纪要…',
      recordingDuration: '记录时长',
      viewTabTranscript: '全文转记',
      viewTabMinutes: '内容纪要',
      viewTabNotes: '要点',
      start: '开始记录',
      stop: '结束记录',
      resumeMeeting: '继续记录',
      newMeeting: '新会议',
      pause: '暂停',
      resume: '继续',
      idle: '未开始',
      starting: '正在启动麦克风…',
      transcribing: '识别中…',
      elapsed: '已记录',
      pausedStatus: '已暂停 · 已录',
      pauseLongHint: '仍在暂停（已超过 10 分钟）',
      speakingNow: '正在发言',
      preparing: '准备模型…',
      speechPreparing: '正在准备语音模型…',
      speechAutoStart: '模型就绪后自动开始…',
      speechDownloading: '正在下载语音模型',
      speechRouteMissing: '宿主路由未注册：请重启 Harness 或更新本插件',
      setupPrepareFailed: '语音模型准备失败',
      setupPrepareStalled: '语音模型下载停滞',
      stopFinishing: '正在收尾：等待最后几段识别完成…',
      stopRemaining: '剩余',
      stopElapsed: '已等待',
      stopFinished: '收尾完成，会议已保存',
      empty: '还没有实录。开始后对着麦克风说话，文字会实时出现在这里。',
      titleEditHint: '会议名称可随时修改；清空恢复默认名（日期 + 开始时间），未改动时结束后按实录自动命名',
      unnamed: '（未命名会议）',
      recording: '录制中',
      pausedLabel: '已暂停',
      stoppedLabel: '已结束',
      tabTranscript: '实录',
      tabNotes: '要点与安排',
      tabMinutes: '纪要',
      followNewest: '跟随最新',
      jumpToNewest: '回到最新',
      seekHint: '点击跳到这一句',
      segments: '句',
      corrected: '已纠错',
      correctedHint: '这些句子由大模型按上下文自动订正；鼠标停在句子上可看识别原文。',
      partialHint: '正在实时识别本句；说完这句稍作停顿，会自动定稿并按上下文订正。',
      speakerNames: '发言人名称编辑',
      speakerNamesEmpty: '还没有识别出发言人：开始录音后，说话并停顿，标签会出现在这里。',
      speakerNameHint: '默认标记为「发言人1、发言人2…」；填入真实姓名后，实录、纪要与导出文件里的同一声音会全部替换。',
      speakerNamePlaceholder: '真实姓名',
      speakerChipHint: '点击修改这位发言人',
      voiceSuggestions: '声纹库建议',
      voiceSoundsLike: '听起来像',
      voiceAccept: '采用',
      speakerRelabel: '重新识别发言人',
      speakerRelabeling: '正在重识别…',
      speakerRelabelDone: '重识别完成',
      speakerDownloading: '正在下载声纹模型',
      speakerFailed: '发言人识别不可用',
      speakerNamesCount: '位发言人',
      copySrt: '复制 SRT',
      copy: '复制全文',
      copyForFix: '复制纠错请求',
      copied: '已复制',
      exportFile: '保存为文件（.zip）',
      packageSaving: '正在打包这场会议',
      packageSaved: '已保存到文件',
      packageFailed: '打包失败',
      needTranscript: '需要先有一段实录',
      points: '要点',
      tasks: '工作安排',
      point_decision: '决定',
      point_point: '要点',
      point_risk: '风险',
      point_question: '待定',
      taskDraft: '待确认',
      taskConfirmed: '已确认',
      noAnalysis: '还没有要点或安排。点「本地提取」按规则生成草稿，或在对话里让 Agent 整理。',
      notesNoRecording: '本场还没有实录：先去「实录」页开始记录，也可以直接在下面写一条。',
      addEntry: '添加',
      entryAdded: '已添加',
      taskTextRequired: '请先写工作安排的内容',
      pointTextRequired: '请先写要点的内容',
      pointTextPh: '一条要点…',
      taskTitlePh: '一条工作安排…',
      originManual: '手填',
      originAgent: 'Agent',
      originRule: '规则',
      confirm: '确认',
      taskMarkDone: '勾选表示已完成',
      taskDoneAt: '完成于',
      ownerPh: '负责人',
      duePh: '时间',
      priority: '优先级',
      priorityHigh: '高',
      priorityNormal: '中',
      priorityLow: '低',
      dueCustom: '精确时间…',
      dueUnset: '不设时间',
      dueToday: '今天 18:00',
      dueTomorrowMorning: '明早 9:00',
      dueTomorrow: '明天 18:00',
      dueFriday: '本周五 18:00',
      dueMonday: '下周一 9:00',
      dueMonthEnd: '本月末 18:00',
      extractNow: '本地提取',
      extractDone: '已提取',
      extractEmpty: '没有识别出明显的要点或行动项。可以在对话里让 Agent 精修。',
      saveEntry: '保存',
      cancelEntry: '取消',
      editEntry: '编辑',
      remove: '删除',
      minutes: '生成纪要',
      minutesDocx: '导出 Word',
      minutesDone: '纪要已生成',
      minutesDocxDone: 'Word 已导出',
      minutesEmpty: '这场会议还没有纪要。点「生成纪要」按实录与要点出一份 Markdown。',
      minutesTabEmpty: '还没有纪要。点「生成纪要」让宿主依据实录写一份，或让 Agent 用 meeting_save_document 存更细的总结。',
      documentsTitle: '已存文档',
      openDocument: '查看',
      closeDocument: '收起',
      agentDone: '已更新',
      historyTitle: '历史会议',
      historyPlaceholder: '搜索历史会议（名称 / 日期 / 实录关键词）',
      historyLoading: '正在读取…',
      historyEmpty: '没有匹配的会议',
      historyBlank: '空',
      historyChoose: '打开',
      historyViewing: '正在查看历史会议',
      historyBack: '返回本会话',
      historyViewOnly: '历史会议为只读。',
      historyAll: '已全部显示',
      historyMore: '滚动加载更多…',
      historyDelete: '删除',
      historyDeleteHint: '删除这条会议记录保存的本机内容（实录、要点、任务、纪要与录音），不可恢复',
      historyDeleteConfirm: '删除后无法恢复',
      historyDeleted: '已删除本机保存的会议记录',
      historyDeleteFailed: '删除未完成：部分文件未能删除',
      settingsNav: '会议记录',
      settingsIntro: '会议记录插件的设置：识别模型、发言人识别、实录切句与会议术语。识别全程在本机完成，录音不出这台电脑；录音窗口只管录音，配置都在这里。',
      settingsModels: '模型',
      settingsSpeaker: '发言人识别',
      settingsTranscript: '实录与切句',
      settingsTerms: '本场会议术语（会议专用）',
      vocabularyTitle: '内置常用词与专有词库',
      vocabularyHint: '独立于本场会议术语，随插件维护；默认启用常用会议词，行业词包按需勾选。只检索相关候选辅助后台大模型纠错，不强制替换，不改变本机语音识别模型。人工订正和会议术语优先。',
      vocabularyEnable: '启用内置词库辅助纠错',
      vocabularyBrowse: '查看词条（只读）',
      vocabularyCommon: '基础词包',
      vocabularyPacks: '词包列表',
      vocabularySelected: '已选词包',
      vocabularySave: '保存词库设置',
      modelsHint: '识别用哪个模型是数据不是写死的：可下载更强的本地模型、从文件导入、启用、删除；没装好或校验不过不允许启用。',
      modelsLocalTitle: '本地模型（录音不出本机）',
      summaryModelTitle: '后台会议总结模型',
      summaryModelHint: '结束会议后用插件内置提示词直接调用所选 DSH 大模型整理纪要，不执行普通对话提示词，不另存 API Key；选「DSH 默认」时跟随 DSH 当前模型，选其他模型时自动使用其所属通道。',
      summaryModelModel: '总结模型',
      summaryModelDefault: 'DSH 默认',
      summaryModelStale: '（当前配置，不在可用列表）',
      summaryModelEmpty: '没有可选的大模型：请先在 DSH 设置 → 模型中配置并启用一个大模型通道。',
      summaryModelCurrentDefault: '当前 DSH 默认',
      summaryModelUnsetDefault: '未设置',
      summaryModelPrivacy: '原始录音仍保存在本机；自动总结与转写自动纠错会把转写（和笔记）发送给上述大模型。聊天中只显示总结状态，纪要内容在右侧展示。',
      summaryModelSave: '保存总结模型',
      summaryModelSaving: '正在保存…',
      summaryModelSaved: '已保存，下次结束会议时生效',
      modelDirectory: '模型目录',
      modelDownloading: '正在下载',
      modelInstalled: '已安装',
      modelImported: '已导入文件',
      modelActivated: '已切换模型',
      modelRemoved: '已删除模型',
      modelKindAsr: '语音识别',
      modelKindSpeaker: '发言人声纹',
      modelKindOther: '其它',
      modelStateReady: '已就绪',
      modelStateBad: '校验不过',
      modelStateMissing: '未安装',
      modelByDsh: '随 DSH 提供',
      modelInUse: '使用中',
      modelActivate: '启用',
      modelInstall: '下载安装',
      modelRetry: '重试下载',
      modelImportFile: '从文件导入',
      modelImportHint: '选择该模型的文件（离线机房 / 内网镜像 / 自训练模型）',
      modelRemove: '删除',
      modelLicence: '许可',
      saved: '已保存',
      speakerThreshold: '聚类严格度',
      speakerFullRelabel: '结束时全量重判（推荐）',
      speakerSettingsHint: '录音时自动识别发言人，默认标记为「发言人1、发言人2…」。人多调高（0.7，宁可多分几个声音）；人少或语气变化大调低（0.5）。改阈值会重启识别进程。',
      speakerRestarted: '阈值已保存，识别进程已重启',
      speakerSave: '保存发言人设置',
      transcriptTitle: '实录',
      transcriptNormalize: '数字规整（二零二六年十月十九号 → 2026年10月19日）',
      transcriptNormalizeHint: '本机规则、不联网；只改写形状，原文永远保留可对照。',
      transcriptSmooth: '语义顺滑（清理「嗯、啊」、口吃重复与外文语气词残留）',
      transcriptSmoothHint: '可选开启，默认关闭；本机规则清理停顿词，可能影响语气表达，原文保留可对照。',
      transcriptSave: '保存实录设置',
      terms: '会议术语（人名 / 公司 / 项目 / 专业词）',
      termsHint: '每行一条，三种写法：① 错词=正确词 → 直接替换，例如 romi中心=罗米中心；② 只写一个词 → 同音订正，例如 陈一鸣（听到 沉一明 也会改成它）；③ 前面加 * → 连单字也按同音订正，例如 *李。订正不改动原始转写，鼠标停在句子上可看原文。',
      needSession: '还没有可用的会话：请先打开一个对话。',
      noMeeting: '这个会话还没有会议记录。点「开始记录」录一场。',
      error: '出错',
      closeDialog: '关闭',
      moreActions: '更多',
      systemUnavailable: '系统内录未启动：请检查系统音频录制授权（与麦克风授权不同）、macOS 版本与命令行工具。无需屏幕画面录制权限',
      systemMissingHeadphones: '未录到系统声音，而且现在戴着耳机：音乐/对方的声音进不了麦克风。请检查系统音频录制授权后重新开始，并播放音乐确认电平与录音回放',
      systemWindowsUnavailable: 'Windows 系统内录未启动：请检查默认播放设备（扬声器/耳机）是否可用，以及 .NET Framework 4.x 编译工具。WASAPI 内录不需要屏幕录制或虚拟声卡；麦克风需允许桌面应用访问。Windows 实机兼容性待验收。',
      systemBadgeLive: '系统声音已连接',
      systemBadgeOff: '系统声音未接入',
      bluetoothMicNote: '正在使用蓝牙耳机的麦克风：系统可能把耳机切到通话音质。想保持高音质播放，可在系统声音设置中把输入改为内建或独立麦克风，输出仍用耳机，再重新开录。',
      systemBadgeHint: '电脑正在播放的声音（音乐/对方发言）是否已并入这场录音',
      systemFailed: '系统声音来源未能打开，本次仅录制麦克风',
      systemEnded: '系统声音共享已结束，后续仅录制麦克风',
    }

    const en = {
      open: 'Meeting notes',
      openHint: 'Open the meeting-notes window',
      panelLabel: 'Meeting Notes',
      launcherHint: 'The meeting-notes window should have opened; if not, reopen it below.',
      notesTitle: 'Notes',
      notesExpand: 'Expand notes',
      notesCollapse: 'Collapse notes',
      notesPlaceholder: 'Jot key points — DSH will weave them into the minutes…',
      recordingDuration: 'Duration',
      viewTabTranscript: 'Transcript',
      viewTabMinutes: 'Minutes',
      viewTabNotes: 'Key points',
      start: 'Start recording',
      stop: 'End recording',
      resumeMeeting: 'Continue recording',
      newMeeting: 'New meeting',
      pause: 'Pause',
      resume: 'Resume',
      idle: 'Not started',
      starting: 'Starting the microphone…',
      transcribing: 'Transcribing…',
      elapsed: 'Recorded',
      pausedStatus: 'Paused · recorded',
      pauseLongHint: 'Still paused (over 10 minutes)',
      speakingNow: 'Speaking',
      preparing: 'Preparing the model…',
      speechPreparing: 'Preparing the speech model…',
      speechAutoStart: 'Starts automatically once the model is ready…',
      speechDownloading: 'Downloading the speech model',
      speechRouteMissing: 'Host route missing: restart Harness or update this plugin',
      setupPrepareFailed: 'Could not prepare the speech model',
      setupPrepareStalled: 'Speech model download stalled',
      stopFinishing: 'Finishing: waiting for the last cues…',
      stopRemaining: 'remaining',
      stopElapsed: 'waited',
      stopFinished: 'Finished, the meeting is saved',
      empty: 'Nothing yet. Start recording and speak; the text appears here live.',
      titleEditHint: 'Rename anytime; clearing it restores the default (date + start time), and an untouched name is still summarized from the transcript when the meeting ends',
      unnamed: '(Untitled meeting)',
      recording: 'Recording',
      pausedLabel: 'Paused',
      stoppedLabel: 'Ended',
      tabTranscript: 'Transcript',
      tabNotes: 'Points & tasks',
      tabMinutes: 'Minutes',
      followNewest: 'Follow latest',
      jumpToNewest: 'Back to latest',
      seekHint: 'Click to jump to this cue',
      segments: 'cues',
      corrected: 'auto-corrected',
      correctedHint: 'These lines were auto-corrected from context by the model; hover a line to see the raw recognition.',
      partialHint: 'This line is still being recognized live; pause a beat and it settles and self-corrects.',
      speakerNames: 'Edit speaker names',
      speakerNamesEmpty: 'No speakers identified yet: start recording, speak and pause, labels appear here.',
      speakerNameHint: 'Voices default to 发言人1, 发言人2…; entering a real name replaces that voice everywhere — transcript, minutes and exports.',
      speakerNamePlaceholder: 'Real name',
      speakerChipHint: 'Click to edit this speaker',
      voiceSuggestions: 'Voice library suggestions',
      voiceSoundsLike: 'sounds like',
      voiceAccept: 'Accept',
      speakerRelabel: 'Re-identify speakers',
      speakerRelabeling: 'Re-identifying…',
      speakerRelabelDone: 'Re-identification done',
      speakerDownloading: 'Downloading the voice model',
      speakerFailed: 'Speaker recognition unavailable',
      speakerNamesCount: 'speakers',
      copySrt: 'Copy SRT',
      copy: 'Copy text',
      copyForFix: 'Copy correction request',
      copied: 'Copied',
      exportFile: 'Save as file (.zip)',
      packageSaving: 'Packaging this meeting',
      packageSaved: 'Saved to file',
      packageFailed: 'Packaging failed',
      needTranscript: 'A recorded transcript is needed first',
      points: 'Points',
      tasks: 'Tasks',
      point_decision: 'Decision',
      point_point: 'Point',
      point_risk: 'Risk',
      point_question: 'Open',
      taskDraft: 'Draft',
      taskConfirmed: 'Confirmed',
      noAnalysis: 'No points or tasks yet. Use "Extract locally" for rule-based drafts, or ask the agent in chat.',
      notesNoRecording: 'No transcript yet: record on the Transcript tab, or type an entry below.',
      addEntry: 'Add',
      entryAdded: 'Added',
      taskTextRequired: 'Write the task first',
      pointTextRequired: 'Write the point first',
      pointTextPh: 'One point…',
      taskTitlePh: 'One assignment…',
      originManual: 'typed',
      originAgent: 'Agent',
      originRule: 'rule',
      confirm: 'Confirm',
      taskMarkDone: 'Tick when finished',
      taskDoneAt: 'Finished at',
      ownerPh: 'Owner',
      duePh: 'Due',
      priority: 'Priority',
      priorityHigh: 'High',
      priorityNormal: 'Normal',
      priorityLow: 'Low',
      dueCustom: 'Exact time…',
      dueUnset: 'No due',
      dueToday: 'Today 18:00',
      dueTomorrowMorning: 'Tomorrow 9:00',
      dueTomorrow: 'Tomorrow 18:00',
      dueFriday: 'Friday 18:00',
      dueMonday: 'Monday 9:00',
      dueMonthEnd: 'Month end 18:00',
      extractNow: 'Extract locally',
      extractDone: 'Extracted',
      extractEmpty: 'No clear points or actions recognized. Ask the agent in chat to refine.',
      saveEntry: 'Save',
      cancelEntry: 'Cancel',
      editEntry: 'Edit',
      remove: 'Delete',
      minutes: 'Generate minutes',
      minutesDocx: 'Export Word',
      minutesDone: 'Minutes generated',
      minutesDocxDone: 'Word exported',
      minutesEmpty: 'This meeting has no minutes yet.',
      minutesTabEmpty: 'No minutes yet. Generate one from the transcript, or let the agent save a summary with meeting_save_document.',
      documentsTitle: 'Stored documents',
      openDocument: 'Open',
      closeDocument: 'Close',
      agentDone: 'Updated',
      historyTitle: 'History',
      historyPlaceholder: 'Search meetings (name / date / transcript)',
      historyLoading: 'Reading…',
      historyEmpty: 'No matching meetings',
      historyBlank: 'empty',
      historyChoose: 'Open',
      historyViewing: 'Viewing a past meeting',
      historyBack: 'Back to this session',
      historyViewOnly: 'A past meeting is read-only.',
      historyAll: 'All shown',
      historyMore: 'Scroll for more…',
      historyDelete: 'Delete',
      historyDeleteHint: 'Delete this meeting\'s locally stored content (transcript, points, tasks, minutes and recording); cannot be undone',
      historyDeleteConfirm: 'This cannot be undone',
      historyDeleted: 'Meeting record deleted from this machine',
      historyDeleteFailed: 'Deletion incomplete: some files could not be removed',
      settingsNav: 'Meeting notes',
      settingsIntro: 'The meeting-notes plugin\'s settings: recognition models, speaker recognition, transcript cues and terminology. Recognition runs entirely on this machine; the record window only records, configuration lives here.',
      settingsModels: 'Models',
      settingsSpeaker: 'Speaker recognition',
      settingsTranscript: 'Transcript & cues',
      settingsTerms: 'Meeting-specific terminology',
      vocabularyTitle: 'Built-in common & specialist vocabulary',
      vocabularyHint: 'Maintained with the plugin, separate from meeting terms. Common vocabulary is enabled by default; select industry packs as needed. Retrieves relevant hints for background LLM correction, not forced replacements or acoustic-model hotwords. Manual edits and meeting terms take priority.',
      vocabularyEnable: 'Use built-in vocabulary for correction',
      vocabularyBrowse: 'Browse entries (read-only)',
      vocabularyCommon: 'Base vocabulary',
      vocabularyPacks: 'Vocabulary packs',
      vocabularySelected: 'selected',
      vocabularySave: 'Save vocabulary settings',
      modelsHint: 'Which model recognises what is data, not code: download a stronger local model, import from files, activate, remove; an unverified model cannot be activated.',
      modelsLocalTitle: 'Local models (recording never leaves this machine)',
      summaryModelTitle: 'Background summary model',
      summaryModelHint: 'After a meeting ends, its minutes are compiled through the selected DSH model with the plugin\'s built-in prompt — no ordinary chat prompt runs and no API key is stored here. "DSH default" follows the current DSH model; any other pick uses that model\'s own channel automatically.',
      summaryModelModel: 'Summary model',
      summaryModelDefault: 'DSH default',
      summaryModelStale: ' (configured, not in the list)',
      summaryModelEmpty: 'No model to pick: configure and enable a model channel in DSH Settings → Models first.',
      summaryModelCurrentDefault: 'Current DSH default',
      summaryModelUnsetDefault: 'not set',
      summaryModelPrivacy: 'The raw recording stays on this machine; the automatic summary and the transcript auto-correction send the transcript (and notes) to the model above. Chat shows only the status; the minutes appear on the right.',
      summaryModelSave: 'Save summary model',
      summaryModelSaving: 'Saving…',
      summaryModelSaved: 'Saved; takes effect at the next meeting end',
      modelDirectory: 'Model directory',
      modelDownloading: 'Downloading',
      modelInstalled: 'Installed',
      modelImported: 'Imported file',
      modelActivated: 'Model activated',
      modelRemoved: 'Model removed',
      modelKindAsr: 'Speech recognition',
      modelKindSpeaker: 'Speaker voiceprint',
      modelKindOther: 'Other',
      modelStateReady: 'Ready',
      modelStateBad: 'Unverified',
      modelStateMissing: 'Not installed',
      modelByDsh: 'Shipped with DSH',
      modelInUse: 'In use',
      modelActivate: 'Activate',
      modelInstall: 'Download',
      modelRetry: 'Retry download',
      modelImportFile: 'Import from file',
      modelImportHint: 'Pick this model\'s file (offline machine / private mirror / self-trained)',
      modelRemove: 'Remove',
      modelLicence: 'Licence',
      saved: 'Saved',
      speakerThreshold: 'Clustering strictness',
      speakerFullRelabel: 'Full re-identification at the end (recommended)',
      speakerSettingsHint: 'Speakers are recognised while recording and default to 发言人1, 发言人2… Raise for crowds (0.7), lower for few people or varied tone (0.5). Changing the threshold restarts the recognizer.',
      speakerRestarted: 'Threshold saved, recognizer restarted',
      speakerSave: 'Save speaker settings',
      transcriptTitle: 'Transcript',
      transcriptNormalize: 'Normalize numbers (twenty twenty-six October nineteen → 2026年10月19日 style)',
      transcriptNormalizeHint: 'Local rules, offline; only shapes the text, the raw recognition stays auditable.',
      transcriptSmooth: 'Disfluency smoothing (drops standalone 嗯/啊, stutters and stray foreign fillers)',
      transcriptSmoothHint: 'Local rules, offline — the readable-transcript pass mainstream recorders ship; the raw text stays auditable.',
      transcriptSave: 'Save transcript settings',
      terms: 'Meeting terminology (names / companies / projects / jargon)',
      termsHint: 'One entry per line: ① wrong=right → literal replacement; ② a single word → homophone correction; ③ prefix * → single characters too. The raw transcript is never modified.',
      needSession: 'No conversation available: open a session first.',
      noMeeting: 'This session has no meeting record yet. Start recording first.',
      error: 'Error',
      closeDialog: 'Close',
      moreActions: 'More',
      systemUnavailable: 'System capture did not start. Check system audio recording consent (separate from microphone consent), macOS version and Command Line Tools. No screen/video recording permission is required',
      systemMissingHeadphones: 'System audio is not being recorded and you are on headphones: music / the far side cannot reach the microphone. Check system audio recording consent, restart recording, and play music to verify both the level and recorded playback',
      systemWindowsUnavailable: 'Windows system capture did not start. Check the default playback device and .NET Framework 4.x compiler. WASAPI requires no screen capture or virtual audio driver; allow desktop microphone access for mic recording. Windows hardware validation is pending.',
      systemBadgeLive: 'System audio connected',
      systemBadgeOff: 'No system audio',
      bluetoothMicNote: 'Recording through a Bluetooth headset mic may switch playback to call quality. To retain hi-fi playback, use the built-in or a separate microphone as system input, keep the headphones as output, then record again.',
      systemBadgeHint: 'Whether the computer\'s own playback (music / the far side) is being mixed into this recording',
      systemFailed: 'The system-audio source could not be opened; recording the microphone only',
      systemEnded: 'System-audio sharing ended; recording continues on the microphone only',
    }

    /**
     * Locale lookup for the capture controller, which runs outside the components
     * that receive a bound `t` through props.
     * @param key - dictionary key.
     * @returns the current-language text.
     */
    const t9n = (key) => zh[key] ?? en[key] ?? key

    // ── Styles ────────────────────────────────────────────────────────────────

    /**
     * The plugin's one control stylesheet. This plugin renders its own controls (no shared
     * primitives module is imported), all colors coming from the host's theme tokens so
     * light and dark both stay correct.
     */
    const CONTROL_CSS = `
.mn-btn { font: inherit; font-size: 12px; line-height: 1.5; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); cursor: pointer;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease; }
.mn-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.mn-btn:active { background: var(--dsw-alias-bg-base); }
.mn-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.mn-btn:disabled { opacity: .5; cursor: not-allowed; }
.mn-btn--active { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary); font-weight: 600; }
.mn-btn--small { padding: 1px 8px; font-size: 11px; border-radius: 4px; }
.mn-btn--primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; font-weight: 600; }
.mn-btn--primary:hover { filter: brightness(1.08); background: var(--dsw-alias-brand-primary); }
.mn-btn--danger { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); color: #fff; font-weight: 600; }
.mn-btn--danger:hover { filter: brightness(1.08); background: var(--dsw-alias-state-error-primary); }
.mn-btn--ghost { border-color: transparent; background: none; }
.mn-btn--ghost:hover { background: var(--dsw-alias-bg-layer-2); }
.mn-btn--tab { border-color: transparent; background: none; border-radius: 8px; padding: 6px 12px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.mn-btn--tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.mn-btn--tab-active { border-color: transparent; background: none; border-radius: 8px; padding: 6px 12px; font-size: 13px;
  color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary); }
.mn-btn--menu { display: block; width: 100%; text-align: left; border-color: transparent; background: none;
  padding: 6px 12px; white-space: nowrap; border-radius: 8px; }
.mn-btn--menu:hover { background: var(--dsw-alias-bg-layer-2); }
.mn-field, .mn-picker { font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; padding: 3px 8px; box-sizing: border-box; }
.mn-field::placeholder { color: var(--dsw-alias-label-secondary); }
.mn-field:hover, .mn-picker:hover { border-color: var(--dsw-alias-border-l2); }
.mn-field:focus, .mn-picker:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.mn-field:disabled, .mn-picker:disabled { opacity: .55; cursor: not-allowed; }
.mn-field--wide { flex: 1 1 120px; min-width: 0; }
.mn-field--tight { width: 84px; }
.mn-field--area { min-height: 72px; resize: vertical; width: 100%; }
/* Single-line fields inside COLUMN flex labels: the wide variant's flex-basis
   would become their height there, so this variant sizes the width only. */
.mn-field--line { width: 100%; }
.mn-card { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.mn-list { display: flex; flex-direction: column; gap: 2px; }
.mn-row { display: flex; align-items: baseline; gap: 8px; padding: 3px 6px; border-radius: 6px; }
.mn-row:hover { background: var(--dsw-alias-bg-layer-2); }
.mn-hover { transition: background .12s ease; }
.mn-hover:hover { background: var(--dsw-alias-bg-layer-2); }
/* The speaker chip inside a transcript row: same pill as before, but a button now —
   clicking it opens the speaker-names dialog instead of seeking the recording. */
.mn-chipbtn { font: inherit; font-size: 11px; line-height: 1.6; padding: 1px 8px; border-radius: 999px;
  border: 1px solid transparent; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap;
  transition: color .12s ease, border-color .12s ease; }
.mn-chipbtn:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-border-l2); }
.mn-chipbtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
@keyframes mn-pulse { 0% { opacity: 1 } 50% { opacity: .25 } 100% { opacity: 1 } }
.mn-dot--live { animation: mn-pulse 1.2s ease-in-out infinite; }
/* The open cue's live line (“边说边出字”): the still-growing recognition with a
   typing caret; it is replaced by the settled cue — with its self-correction —
   the moment the speaker pauses. */
.mn-caret { display: inline-block; width: 2px; height: 1em; margin-left: 3px; border-radius: 1px;
  vertical-align: -0.15em; background: var(--dsw-alias-brand-primary);
  animation: mn-pulse 1s ease-in-out infinite; }
/* The composer chip mirrors the shell's permission chip (conversation.input.permission):
   28px tall, 13px label, transparent, borderless; the only state cue is a hover wash. */
.mn-chip { font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; height: 28px;
  display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border: none; outline: none;
  border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; white-space: nowrap; transition: background .12s ease, color .12s ease; }
@media (hover:hover) { .mn-chip:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); } }
.mn-chip:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.mn-chip:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.mn-chip--live { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
/* The reference toolbar's secondary button: pale-gray filled, borderless. */
.mn-btn--soft { border-color: transparent; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.mn-btn--soft:hover { background: var(--dsw-alias-interactive-bg-hover); }
.mn-btn--soft:disabled { opacity: .55; }
/* The history row's delete button: a quiet trash glyph that only turns destructive-red
   on hover, so the row's own click-to-open stays the primary action. */
.mn-del { font: inherit; border: none; background: none; cursor: pointer; padding: 4px; border-radius: 6px;
  display: inline-flex; align-items: center; color: var(--dsw-alias-label-dimmed);
  transition: background .12s ease, color .12s ease; }
@media (hover:hover) { .mn-del:not(:disabled):hover { background: var(--dsw-alias-state-error-bg, rgba(255,59,48,.10)); color: var(--dsw-alias-state-error-primary); } }
.mn-del:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
`
    if (typeof document !== 'undefined' && document.getElementById('mn-control-style') === null) {
      const sheet = document.createElement('style')
      sheet.id = 'mn-control-style'
      sheet.textContent = CONTROL_CSS
      document.head.appendChild(sheet)
    }

    /** Inline layout styles; colors always theme tokens. */
    const styles = {
      // The dock chip under the composer.
      // `position: relative` anchors the hidden label-width probe below.
      dockWrap: { display: 'inline-flex', alignItems: 'center', position: 'relative' },
      // No `background` here on purpose: an inline background would outrank the
      // .mn-chip stylesheet rules (rest AND :hover), killing the hover wash —
      // the shell's own composer chips get their hover the same class-driven way.
      dockChip: { display: 'inline-flex', alignItems: 'center', gap: '4px', font: 'inherit', fontSize: '13px',
        fontWeight: 500, lineHeight: '20px', height: '28px', padding: '0 8px', borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer', whiteSpace: 'nowrap', border: 'none', outline: 'none',
        color: 'var(--dsw-alias-label-secondary)', transition: 'background .12s ease, color .12s ease' },
      dockChipLive: { color: 'var(--dsw-alias-state-error-primary)', fontWeight: 600 },
      // The collapsed chip: a bare 28px icon square, sized like the composer's own
      // icon-only tool buttons (eye / mic / send) it sits next to.
      dockChipIcon: { width: '28px', padding: '0', justifyContent: 'center' },
      // Hidden width probe for the FULL label: absolute + visibility keeps it out of
      // layout while its offsetWidth feeds the collapse/expand hysteresis threshold.
      dockMeasure: { position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap', pointerEvents: 'none',
        font: 'inherit', fontSize: '13px', fontWeight: 500, lineHeight: '20px' },
      // The launcher main page behind the left-sidebar entry.
      launcher: { height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: '12px', color: 'var(--dsw-alias-label-secondary)' },
      launcherHint: { margin: 0, fontSize: '13px' },
      // The always-visible audio bar above the tabs while viewing a finished meeting.
      viewAudio: { display: 'block', width: 'calc(100% - 36px)', margin: '10px auto 0' },
      // The record dialog.
      overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: 4000 },
      dialog: { position: 'relative', display: 'flex', flexDirection: 'column', width: 'min(92vw, 880px)',
        height: 'min(86vh, 760px)', borderRadius: '16px', background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)', boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
        overflow: 'hidden', color: 'var(--dsw-alias-label-primary)' },
      dialogHead: { display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 18px 0' },
      // The controls row under the title row: buttons at the left, duration beside them.
      // The controls row styled as the reference's floating toolbar card.
      controlRow: { display: 'inline-flex', alignItems: 'center', gap: '8px', width: 'fit-content',
        padding: '6px 10px', margin: '10px 18px 2px', borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' },
      // The live content row: transcript (left) | toggle strip | notes pad (right).
      contentRow: { display: 'flex', flex: '1 1 auto', minHeight: 0, gap: '0px' },
      transcriptPane: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '10px' },
      // The collapse/expand seat BETWEEN the two panes: a slim vertical strip whose
      // button flips the notes pad open/closed (it stays at the dialog's right edge
      // when the pad is collapsed).
      notesToggle: { flex: '0 0 20px', alignSelf: 'stretch', display: 'flex', alignItems: 'center',
        justifyContent: 'center', cursor: 'pointer', font: 'inherit', border: 'none',
        borderLeft: '1px solid var(--dsw-alias-border-l1)', borderRight: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)', padding: '0' },
      notesToggleGlyph: { fontSize: '15px', lineHeight: 1, fontWeight: 600, padding: '8px 4px', borderRadius: '6px',
        background: 'var(--dsw-alias-bg-layer-2)', transition: 'background .12s ease' },
      notesPanel: { flex: '0 0 320px', maxWidth: '42%', display: 'flex', flexDirection: 'column', minHeight: 0,
        paddingLeft: '10px' },
      notesHead: { display: 'flex', alignItems: 'center', gap: '6px' },
      notesEditor: { flex: '1 1 auto', minHeight: '120px', height: 'auto', resize: 'none',
        fontSize: '13px', lineHeight: '1.7' },
      statusPill: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600,
        padding: '3px 10px', borderRadius: '999px', whiteSpace: 'nowrap',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
      statusPillLive: { color: 'var(--dsw-alias-state-error-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
      statusPillPaused: { color: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
      statusDot: { width: '8px', height: '8px', borderRadius: '50%', background: 'currentColor', flex: '0 0 auto' },
      clock: { fontSize: '13px', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      titleStatic: { flex: '1 1 auto', minWidth: '80px', fontSize: '15px', fontWeight: 600,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      // The editable name a live recording wears in the header: quiet until focused,
      // the browser's own focus ring says "type here".
      titleInput: { flex: '1 1 auto', minWidth: '120px', maxWidth: '460px', height: '30px',
        fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px', padding: '0 10px', overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' },
      iconBtn: { border: 'none', background: 'none', cursor: 'pointer', padding: '6px', borderRadius: '8px',
        color: 'var(--dsw-alias-label-secondary)', display: 'inline-flex', alignItems: 'center' },
      iconBtnHover: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
      tabs: { display: 'flex', gap: '4px', padding: '8px 18px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '10px' },
      foot: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 18px 14px',
        borderTop: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' },
      footRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      // Transient messages under the header; rendered only while a message exists.
      statusRow: { display: 'flex', alignItems: 'baseline', gap: '12px', padding: '6px 18px 0',
        minHeight: 0, overflow: 'hidden' },
      // The record bar: controls at the left, the elapsed duration right beside them.
      duration: { fontSize: '13px', fontWeight: 600, fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' },
      status: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      note: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      spacer: { flex: '1 1 auto' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      label: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      chip: { display: 'inline-block', fontSize: '11px', padding: '1px 8px', borderRadius: '999px', whiteSpace: 'nowrap',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
      chipBrand: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-brand-primary)' },
      // The expanded pack list lives in a FIXED-height panel that scrolls inside:
      // sixteen packs × two rows each would otherwise stretch the settings card
      // far beyond one screen. Height is capped here, scrolling happens in-panel.
      vocabPanel: { maxHeight: '320px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px',
        padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)' },
      // One pack's browsable words: bounded too, so a 60-entry paragraph cannot
      // push the panel taller again — the word list scrolls in its own box.
      vocabEntries: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.8,
        margin: 0, maxHeight: '132px', overflowY: 'auto', paddingRight: '6px' },
      // The speaker-names dialog over the record dialog (its overlay outranks the dialog's).
      namesDialog: { position: 'relative', display: 'flex', flexDirection: 'column', width: 'min(92vw, 520px)',
        maxHeight: 'min(80vh, 560px)', borderRadius: '16px', background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)', boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
        overflow: 'hidden', color: 'var(--dsw-alias-label-primary)' },
      namesHead: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px 0' },
      namesBody: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column',
        gap: '8px', padding: '12px 16px' },
      namesFoot: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px 12px',
        borderTop: '1px solid var(--dsw-alias-border-l1)' },
      namesRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      stamp: { fontSize: '11px', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      systemBadge: { fontSize: '11px', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '999px', padding: '1px 8px', whiteSpace: 'nowrap' },
      systemBadgeLive: { fontSize: '11px', fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-state-success-primary)',
        border: '1px solid var(--dsw-alias-state-success-primary)', borderRadius: '999px', padding: '1px 8px', whiteSpace: 'nowrap' },
      empty: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', textAlign: 'center', padding: '32px 12px', lineHeight: 1.7 },
      list: { display: 'flex', flexDirection: 'column', gap: '2px' },
      transcriptBox: { display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto', flex: '1 1 auto', minHeight: '120px', paddingRight: '4px' },
      segment: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '5px 8px', borderRadius: '8px', cursor: 'pointer' },
      segmentActive: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '5px 8px', borderRadius: '8px', cursor: 'pointer',
        background: 'var(--dsw-alias-bg-layer-2)' },
      segmentText: { flex: '1 1 auto', minWidth: '0', fontSize: '14px', lineHeight: 1.65, wordBreak: 'break-word' },
      partialText: { flex: '1 1 auto', minWidth: '0', fontSize: '14px', lineHeight: 1.65, wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-secondary)' },
      audio: { width: '100%', height: '36px' },
      entryRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' },
      entryRowDraft: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px',
        border: '1px dashed var(--dsw-alias-border-l2)', background: 'transparent' },
      entryText: { flex: '1 1 auto', minWidth: '0', fontSize: '13px', lineHeight: 1.6 },
      taskTitleInput: { flex: '1 1 auto', minWidth: '0', font: 'inherit', fontSize: '13px', border: '1px solid transparent',
        background: 'none', color: 'var(--dsw-alias-label-primary)', padding: '2px 6px', borderRadius: '6px' },
      menuWrap: { position: 'relative', display: 'inline-flex' },
      menu: { position: 'absolute', top: 'calc(100% + 6px)', right: '0', zIndex: 20, minWidth: '160px',
        display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l1)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.28)' },
      historyRow: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '8px 10px', borderRadius: '10px',
        cursor: 'pointer', border: '1px solid transparent' },
      historyHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      historyName: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      historyExcerpt: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      docView: { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px',
        lineHeight: 1.7, padding: '12px', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)', maxHeight: '50vh', overflowY: 'auto' },
      banner: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', borderRadius: '8px', fontSize: '12px',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
      // The plugin's page inside DSH's settings (设置 → 会议记录); the dialog the
      // shell mounts supplies the scroll container and the width, this only shapes
      // its content column.
      settingsSection: { maxWidth: '720px', display: 'flex', flexDirection: 'column', gap: '12px',
        color: 'var(--dsw-alias-label-primary)' },
      settingsHeading: { margin: 0, fontSize: '18px', fontWeight: 600 },
      settingsIntro: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      fieldBlock: { display: 'flex', flexDirection: 'column', gap: '4px' },
      // The folder chooser mounted from the workspace settings: a compact modal over
      // the settings page (the record dialog keeps the shell's overlay slot).
      pickDialog: { position: 'relative', display: 'flex', flexDirection: 'column', width: 'min(92vw, 560px)',
        maxHeight: 'min(80vh, 540px)', borderRadius: '16px', background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)', boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
        overflow: 'hidden', color: 'var(--dsw-alias-label-primary)' },
      pickPath: { flex: '1 1 auto', minWidth: 0, fontSize: '12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pickList: { flex: '1 1 auto', minHeight: '160px', overflowY: 'auto', display: 'flex', flexDirection: 'column',
        gap: '2px', padding: '10px 12px', borderTop: '1px solid var(--dsw-alias-border-l1)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      pickRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '8px',
        cursor: 'pointer', fontSize: '13px', wordBreak: 'break-all' },
      pickNew: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px 0' },
      pickFoot: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', padding: '10px 12px' },
      pre: { margin: 0, whiteSpace: 'pre-wrap', fontSize: '11px', fontFamily: 'ui-monospace, Menlo, monospace' },
    }

    // ── Controls ──────────────────────────────────────────────────────────────

    /**
     * One button, rendered by this plugin with theme tokens (no shared primitives
     * module is imported, per current plugin guidance).
     * @param props - usual button props plus `variant` (default/active/small/primary/danger/ghost/tab/tab-active/menu).
     * @returns the button element.
     */
    function Btn(props) {
      const { variant = 'default', className, ...rest } = props
      return h('button', { ...rest, className: `mn-btn mn-btn--${variant}${typeof className === 'string' && className !== '' ? ` ${className}` : ''}` })
    }

    /**
     * One text field (or checkbox/radio/file/range, which keep their native shape).
     * @param props - usual input props plus `variant` (wide for flex ROWS, line for
     *   column labels where wide's flex-basis would become the height, tight/area).
     * @returns the field element.
     */
    function Field(props) {
      const { variant = 'wide', className, ...rest } = props
      if (rest.type === 'checkbox' || rest.type === 'radio' || rest.type === 'file' || rest.type === 'range') {
        return h('input', rest)
      }
      if (variant === 'area') {
        return h('textarea', { ...rest, className: `mn-field mn-field--area${className ? ` ${className}` : ''}` })
      }
      return h('input', { ...rest, className: `mn-field mn-field--${variant}${className ? ` ${className}` : ''}` })
    }

    /**
     * One choice out of a list, as a native select (value/onChange/option children).
     * @param props - usual select props.
     * @returns the control.
     */
    function Picker(props) {
      const { className, ...rest } = props
      return h('select', { ...rest, className: `mn-picker${className ? ` ${className}` : ''}` })
    }

    /** Id of the datalist offering this meeting's speaker names as owners. */
    const OWNER_LIST_ID = 'meeting-notes-owners'

    /** Task priorities, in the order the picker shows them. */
    const TASK_PRIORITY_VALUES = ['high', 'normal', 'low']
    const PRIORITY_KEYS = { high: 'priorityHigh', normal: 'priorityNormal', low: 'priorityLow' }

    /** Point kinds a reader can choose between when editing. */
    const POINT_KIND_VALUES = ['decision', 'point', 'risk', 'question']

    /** The sentinel that switches the due field from a quick choice to a free picker. */
    const CUSTOM_DUE = '__custom__'

    // ── Utilities ─────────────────────────────────────────────────────────────

    /**
     * Render seconds as zero-padded mm:ss — the stamp each transcript line carries
     * in front of its speaker (`01:34 发言人1：…`).
     * @param seconds - Offset in seconds.
     * @returns the clock text.
     */
    function clock(seconds) {
      const total = Math.max(0, Math.round(seconds))
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
    }

    /**
     * The default name a recording wears from its first second: its own date plus the
     * time it started (`11月14日 01:03`) — same date shape the end-of-meeting
     * summarizer uses, so a default and a summarized name read like one family.
     * @param startedAt - The meeting's start (epoch ms); 0/unknown falls back to now.
     * @returns the default name.
     */
    function defaultTitleOf(startedAt) {
      const when = new Date(startedAt > 0 ? startedAt : Date.now())
      const pad = (value) => String(value).padStart(2, '0')
      return `${when.getMonth() + 1}月${when.getDate()}日 ${pad(when.getHours())}:${pad(when.getMinutes())}`
    }

    /**
     * Encode bytes as base64 for the JSON carrier.
     * @param bytes - Source bytes.
     * @returns base64 text without a data URL prefix.
     */
    function base64(bytes) {
      let text = ''
      for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
      return btoa(text)
    }

    /**
     * Measure one captured block's loudness.
     * @param block - Float samples of one worklet message.
     * @returns the root-mean-square amplitude.
     */
    function blockRms(block) {
      let sum = 0
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i]
      return block.length === 0 ? 0 : Math.sqrt(sum / block.length)
    }

    /**
     * Track one captured block against the adaptive noise floor and the speech state.
     * Pure bookkeeping — the flush decision reads the totals on every block.
     * @param active - Capture session.
     * @param block - Float samples of one worklet message.
     * @returns the block's loudness (reused by the caller).
     */
    function observeBlock(active, block) {
      const rms = blockRms(block)
      // The floor drops the moment a block is quieter (a real lull), and rises only
      // while the block is NOT latched as speech: continuous music, a lecture or a
      // fan that never stops must not push the speech threshold up against itself.
      if (rms < active.noiseFloor) active.noiseFloor = Math.max(VAD.floorMin, rms)
      else if (active.inSpeech !== true) active.noiseFloor = Math.min(VAD.floorMax, active.noiseFloor + (rms - active.noiseFloor) * VAD.floorRise)
      const enter = Math.min(0.05, Math.max(active.noiseFloor * VAD.enterFactor, VAD.enterMin))
      const exit = Math.max(active.noiseFloor * VAD.exitFactor, VAD.exitMin)
      if (active.inSpeech) {
        if (rms < exit) active.inSpeech = false
      } else if (rms > enter) {
        active.inSpeech = true
      }
      const seconds = block.length / active.audio.sampleRate
      if (active.inSpeech) {
        active.voicedSeconds += seconds
        active.trailingSilence = 0
      } else {
        active.trailingSilence += seconds
      }
      return rms
    }

    /**
     * Decide whether the buffered audio has reached a cue boundary: the speaker paused
     * for real (or the cue ran so long that a shorter pause counts), or the hard cap
     * fell. A buffer without speech is flushed as silence at the cap, never recognized.
     * @param active - Capture session.
     * @returns whether the buffered audio should be sent now.
     */
    function shouldFlush(active) {
      const cueSeconds = active.frames / active.audio.sampleRate
      if (cueSeconds >= VAD.maxCueSeconds) return true
      if (active.voicedSeconds < VAD.minSpeechSeconds) return false
      const endpoint = cueSeconds >= VAD.softMaxCueSeconds ? VAD.shortEndpointSilence : VAD.endpointSilence
      return active.trailingSilence >= endpoint
    }

    /**
     * Box-filter down to the target rate and quantize to little-endian PCM16.
     * @param samples - Captured float samples.
     * @param sourceRate - Sample rate of the capture context.
     * @returns PCM16 bytes at TARGET_RATE.
     */
    function toPcm16(samples, sourceRate) {
      const ratio = sourceRate / TARGET_RATE
      const frames = Math.floor(samples.length / ratio)
      const bytes = new Uint8Array(frames * 2)
      const view = new DataView(bytes.buffer)
      for (let i = 0; i < frames; i++) {
        const start = Math.floor(i * ratio)
        const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
        let sum = 0
        for (let j = start; j < end; j++) sum += samples[j]
        const value = Math.max(-1, Math.min(1, end > start ? sum / (end - start) : 0))
        view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    /**
     * Render seconds as an SRT timecode.
     * @param seconds - Offset in seconds.
     * @returns HH:MM:SS,mmm.
     */
    function timecode(seconds) {
      const ms = Math.max(0, Math.round(seconds * 1000))
      const pad = (value, width) => String(value).padStart(width, '0')
      const hours = Math.floor(ms / 3600000)
      const minutes = Math.floor(ms / 60000) % 60
      const secs = Math.floor(ms / 1000) % 60
      return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(ms % 1000, 3)}`
    }

    /**
     * Split the terminology text into plain terms and literal replacement rules.
     * @param text - One entry per line; `wrong=right` lines become rules.
     * @returns the term list and the replacement pairs.
     */
    function parseTerms(text) {
      const terms = []
      const rules = []
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (line === '' || line.startsWith('#')) continue
        const parts = line.split(/=|=>|→/)
        if (parts.length >= 2) {
          const from = parts[0].trim()
          const to = parts.slice(1).join('=').trim()
          if (from !== '' && to !== '') rules.push([from, to])
          else if (from !== '') terms.push(from)
          continue
        }
        terms.push(line)
      }
      return { terms, rules }
    }

    /**
     * The text a reader sees for one cue: the shaped reading (numbers, smoothed fillers)
     * when there is one, else the correction, else the recognition as it came back — the
     * same chain the host's seenText reads, so the panel and the exports agree.
     * @param segment - Timed transcript segment.
     * @returns the text to display.
     */
    function seenOf(segment) {
      if (typeof segment.normalised === 'string' && segment.normalised !== '') return segment.normalised
      return typeof segment.revised === 'string' ? segment.revised : segment.text
    }

    /**
     * Apply the literal replacement rules to the transcript for display and export.
     * The stored transcript keeps the recognizer's own output; these are the user's edits.
     * @param segments - Timed transcript segments as recognized.
     * @param rules - Replacement pairs.
     * @returns the segments with replacements applied.
     */
    function applyRules(segments, rules) {
      if (rules.length === 0) return segments
      return segments.map((segment) => {
        let text = seenOf(segment)
        for (const [from, to] of rules) text = text.split(from).join(to)
        return text === seenOf(segment) ? segment : { ...segment, revised: text, normalised: undefined }
      })
    }

    /**
     * Render one cue's speaker as a text prefix — `发言人1：` in the reading format
     * every export uses.
     * @param segment - Timed transcript segment.
     * @returns `发言人1：` when the cue carries a speaker, else an empty string.
     */
    function speakerPrefixOf(segment) {
      return typeof segment.speaker === 'string' && segment.speaker !== '' ? `${segment.speaker}：` : ''
    }

    /**
     * Render the transcript as SubRip subtitles — the meeting record's timeline format.
     * @param segments - Timed transcript segments.
     * @returns the SRT document.
     */
    function srtOf(segments) {
      return segments.map((segment, index) => [
        String(index + 1),
        `${timecode(segment.start)} --> ${timecode(segment.end)}`,
        `${speakerPrefixOf(segment)}${seenOf(segment)}`,
        '',
      ].join('\n')).join('\n')
    }

    /**
     * Compose the end-of-meeting correction request: the term list plus the record,
     * ready to paste into a conversation with the agent.
     * @param srt - The SRT record.
     * @param terms - Meeting terminology.
     * @returns the prompt text.
     */
    function correctionPromptOf(srt, terms) {
      const list = terms.length === 0 ? '（未提供）' : terms.join('、')
      return [
        '以下是我用本地语音模型转写的会议实录（SRT 格式）。',
        '',
        `术语表（人名 / 公司 / 项目 / 专业词）：${list}`,
        '',
        '请按上下文订正错别字，尤其是人名与术语；保持 SRT 的时间轴与编号不变。输出两部分：',
        '1. 修订后的完整 SRT；',
        '2. 改动对照表（原文 → 改为 → 依据）。',
        '',
        '实录：',
        '```srt',
        srt.trimEnd(),
        '```',
      ].join('\n')
    }

    /**
     * Turn a failed plugin request into an error that carries its HTTP status, so a
     * missing route (404) and a busy service (5xx) can be told apart.
     * @param value - decoded body, if any.
     * @param response - the failed response.
     * @returns the error to throw.
     */
    function requestFailure(value, response) {
      const message = value !== null && typeof value === 'object' && typeof value.error === 'string' && value.error !== ''
        ? value.error
        : `请求失败 (${response.status})`
      const failure = new Error(message)
      failure.status = response.status
      return failure
    }

    /**
     * POST JSON to the host half and decode the JSON reply.
     * @param route - Route under the plugin prefix.
     * @param body - JSON-serializable body.
     * @param init - Extra fetch options; `signal` lets the caller cancel mid-flight.
     * @returns the decoded reply.
     */
    async function post(route, body, init) {
      const response = await fetch(`${PREFIX}${route}`, {
        ...(init ?? {}),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      let value = {}
      if (text !== '') {
        try { value = JSON.parse(text) } catch { value = {} }
      }
      if (!response.ok) throw requestFailure(value, response)
      return value
    }

    /**
     * GET JSON from the host half and decode the JSON reply.
     * @param route - Route under the plugin prefix, query string included.
     * @returns the decoded reply.
     */
    async function get(route) {
      const response = await fetch(`${PREFIX}${route}`)
      const text = await response.text()
      let value = {}
      if (text !== '') {
        try { value = JSON.parse(text) } catch { value = {} }
      }
      if (!response.ok) throw requestFailure(value, response)
      return value
    }

    /**
     * Read a file name a route asked for out of its Content-Disposition header.
     * @param header - the header value, possibly null.
     * @returns the file name, or null.
     */
    function fileNameFrom(header) {
      if (typeof header !== 'string') return null
      const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header)
      if (encoded !== null) {
        try { return decodeURIComponent(encoded[1].trim()) } catch { /* fall through */ }
      }
      const plain = /filename="([^"]+)"/iu.exec(header)
      return plain === null ? null : plain[1]
    }

    /**
     * Hand a blob to the browser as a download, which is what opens the save dialog.
     * @param blob - the bytes to save.
     * @param name - the file name offered.
     */
    function saveBlob(blob, name) {
      if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }

    /**
     * Ask the browser to save an artifact the host produced.
     * @param name - file name inside the export directory.
     */
    function downloadArtifact(name) {
      if (typeof name !== 'string' || name === '' || typeof document === 'undefined') return
      const link = document.createElement('a')
      link.href = `${PREFIX}/download?name=${encodeURIComponent(name)}`
      link.download = name
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }

    /**
     * Read the stored terminology list, tolerating storage being unavailable.
     * @returns the stored text, or an empty string.
     */
    function readTerms() {
      try {
        return localStorage.getItem(TERMS_KEY) ?? ''
      } catch {
        return ''
      }
    }

    /**
     * Quick due choices, computed against today so the list stays meaningful.
     * @returns one entry per choice, unset first.
     */
    function duePresets() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      const stamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
      const at = (days, hour) => stamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0))
      const weekday = now.getDay()
      const friday = (5 - weekday + 7) % 7 || 7
      const monday = (8 - weekday) % 7 || 7
      return [
        { value: '', key: 'dueUnset' },
        { value: at(0, 18), key: 'dueToday' },
        { value: at(1, 9), key: 'dueTomorrowMorning' },
        { value: at(1, 18), key: 'dueTomorrow' },
        { value: at(friday, 18), key: 'dueFriday' },
        { value: at(monday, 9), key: 'dueMonday' },
        { value: stamp(new Date(now.getFullYear(), now.getMonth() + 1, 0, 18, 0)), key: 'dueMonthEnd' },
      ]
    }

    /**
     * Turn a stored due date into the value a datetime picker needs.
     * @param due - The stored due text.
     * @returns a `YYYY-MM-DDTHH:mm` value.
     */
    function dueDraftOf(due) {
      const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/u.exec(String(due ?? '').trim())
      if (match !== null) return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T18:00`
    }

    /**
     * Names to offer as task owners or speaker names: every voice already named.
     * @param speakers - Voice label to name map.
     * @returns unique names.
     */
    function ownerSuggestions(speakers) {
      const names = []
      for (const name of Object.values(speakers)) {
        if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name)
      }
      return names
    }

    /**
     * The voice label a displayed speaker name belongs to, so a chip click can focus the
     * matching row of the naming dialog. Segments carry display names (the assigned name
     * or the label); an unnamed legacy S1 label displays as 发言人1 while staying S1 on
     * disk, so that translation is tried last.
     * @param state - the shared store (labels + assigned names).
     * @param display - the speaker text shown on a transcript chip.
     * @returns the best-matching label, or the display text when nothing matches.
     */
    function labelOfDisplay(state, display) {
      if (typeof display !== 'string' || display === '') return ''
      for (const [label, name] of Object.entries(state.speakers)) {
        if (name === display) return label
      }
      if (state.labels.includes(display)) return display
      const match = /^发言人(\d+)$/u.exec(display)
      if (match !== null && state.labels.includes(`S${match[1]}`)) return `S${match[1]}`
      return display
    }

    // ── Shared store ──────────────────────────────────────────────────────────

    /**
     * Recording and meeting state shared by the dock chip, the record dialog and the
     * pending-start watcher. The capture lives here rather than inside a component,
     * so closing the dialog or remounting never stops a running meeting.
     */
    const store = {
      // capture
      active: null,
      phase: 'idle',
      meetingId: '',
      sessionId: '',
      audioName: '',
      startedAt: 0,
      seconds: 0,
      segments: [],
      autoStart: false,
      paused: false,
      pausedAt: 0,
      pauseWarned: false,
      stoppedAt: 0,
      audioRev: 0,
      pendingStart: false,
      pendingResume: false,
      finishing: null,
      // meeting data
      points: [],
      tasks: [],
      labels: [],
      speakers: {},
      suggestions: [],
      documents: [],
      meta: { title: '', summary: '' },
      // The header's name field while it is being edited (null = untouched, the
      // default name shows); committed to /title on blur or Enter.
      titleDraft: null,
      termsText: readTerms(),
      // The enumerated input devices: the capture loop watches them for a loopback
      // (virtual sound card) to mix the computer's own audio in automatically.
      inputDevices: [],
      outputDevices: [],
      // models
      speakerModel: { phase: 'unprepared', message: '', completedBytes: 0, totalBytes: 0 },
      speech: { ready: false, phase: 'checking', requesting: false, completedBytes: 0, totalBytes: 0 },
      // view
      open: false,
      tab: 'transcript',
      viewed: null,
      // The finished meeting handed to THIS conversation for auto-summarization:
      // {meetingId, sessionId, title, seconds, segments, audioName, prompted}, or null.
      summaryCard: null,
      // The side notes pad (live recording): open/closed, its plain text, the
      // meeting whose text is loaded.
      notesOpen: true,
      notesText: '',
      notesFor: '',
      historyOpen: false,
      history: { query: '', rows: [], total: 0, loading: false, loadingMore: false },
      // The speaker-names dialog: open/closed, plus the label a transcript-chip click
      // wants preselected (cleared once the dialog has consumed it).
      namesOpen: false,
      namesFocus: '',
      error: '',
      note: '',
      // Live system-audio health, shown as a badge in the transcript toolbar.
      systemAttached: false,
      systemLevelDb: -80,
      // The still-open cue's live partial text (“边说边出字”): recognized while the
      // person talks, displayed under the settled lines, replaced (often with
      // visible self-correction) by the settled cue once the pause lands. Never
      // persisted — empty whenever no cue is open.
      partial: '',
      // Which fixable cause the current note names ('' none, 'permission' the
      // Screen & System Audio Recording toggle) — drives the note's action button.
      noteSource: '',
      listeners: new Set(),
      emit() { for (const listener of this.listeners) listener() },
      subscribe(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
    }

    /**
     * Patch the store and notify every subscriber.
     * @param patch - fields to replace (a shallow merge).
     */
    function set(patch) {
      Object.assign(store, patch)
      store.emit()
    }

    /**
     * Read the shared store inside a component, re-rendering on every change.
     * @returns the store object itself.
     */
    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => store.subscribe(() => force((value) => value + 1)), [])
      return store
    }

    // ── Controller ────────────────────────────────────────────────────────────

    /** Module-local flags that are not worth a re-render. */
    let speechWatchLive = false

    /**
     * Fold one /chunk (or /stop, /state) reply's shared payload into the store.
     * @param reply - the host reply.
     */
    function applyChunkReply(reply, preservePartial = false) {
      if (Array.isArray(reply.segments)) store.segments = reply.segments
      // A previous cue's commit must not erase the NEXT cue's live recognition.
      if (!preservePartial) store.partial = ''
      if (typeof reply.seconds === 'number') store.seconds = reply.seconds
      if (typeof reply.audioName === 'string' && reply.audioName !== '') store.audioName = reply.audioName
      // /stop carries the name the host summarized out of the finished transcript.
      if (typeof reply.title === 'string') store.meta = { ...store.meta, title: reply.title }
      if (Array.isArray(reply.points)) store.points = reply.points
      if (Array.isArray(reply.tasks)) store.tasks = reply.tasks
      if (reply.speakers !== null && typeof reply.speakers === 'object') store.speakers = reply.speakers
      if (Array.isArray(reply.labels)) store.labels = reply.labels
      if (reply.speaker !== undefined) {
        store.speakerModel = {
          phase: reply.speaker.phase,
          message: reply.speaker.message ?? '',
          completedBytes: reply.speaker.completedBytes ?? 0,
          totalBytes: reply.speaker.totalBytes ?? 0,
        }
      }
    }

    /**
     * Encode the still-buffered cue as PCM16 at the target rate.
     * @param active - Capture session.
     * @returns PCM16 bytes of everything buffered for the open cue.
     */
    function pendingPcm(active) {
      const merged = new Float32Array(active.pending.reduce((total, part) => total + part.length, 0))
      let offset = 0
      for (const part of active.pending) {
        merged.set(part, offset)
        offset += part.length
      }
      return toPcm16(merged, active.audio.sampleRate)
    }

    /**
     * Send the buffered audio as one cue and fold the reply into the store.
     * One request runs at a time; audio keeps accumulating while a request is in flight.
     * A buffer that never held real speech is sent marked `silent`: the recording keeps
     * its timeline, but the recognizer never sees noise to hallucinate words out of.
     * @param active - Capture session.
     */
    // Only this lane calls ASR. A commit uses its server-issued receipt instead
    // of starting a second recognition on the same model behind the live stream.
    function recognizeLive(active, pcm, signal) {
      const previous = active.recognitionTail ?? Promise.resolve()
      const task = previous.catch(() => {}).then(() => {
        if (signal?.aborted) throw new Error('recognition superseded')
        return post('/partial', { meetingId: active.meetingId, pcm: base64(pcm) }, { signal })
      })
      active.recognitionTail = task.catch(() => {})
      return task
    }

    async function flush(active) {
      if (active.inflight || active.pending.length === 0) return
      active.inflight = true
      const samples = active.pending
      const voiced = active.voicedSeconds
      const silent = voiced < VAD.minSpeechSeconds
      active.pending = []
      active.frames = 0
      active.voicedSeconds = 0
      active.trailingSilence = 0
      // The cue is settled: any in-flight partial for it is work nobody will
      // display, and freeing the recognizer now is what keeps the settled line fast.
      active.partialAbort?.abort()
      active.partialSeq += 1
      active.partialAt = 0
      const merged = new Float32Array(samples.reduce((total, part) => total + part.length, 0))
      let offset = 0
      for (const part of samples) {
        merged.set(part, offset)
        offset += part.length
      }
      const pcm = toPcm16(merged, active.audio.sampleRate)
      if (!silent) {
        store.phase = 'transcribing'
        store.emit()
      }
      try {
        // Final audio goes through the SAME bounded live lane, once. The commit
        // endpoint only persists this verified result; no competing /chunk ASR.
        let recognition = null
        if (!silent) {
          try { recognition = await recognizeLive(active, pcm) } catch { /* persist audio via legacy fallback */ }
        }
        // If live recognition fails, still send the audio. /chunk writes the WAV
        // before its fallback recognition, so model/network failures never drop audio.
        const reply = await post('/chunk', {
          meetingId: active.meetingId, pcm: base64(pcm), silent,
          recognitionId: recognition?.recognitionId,
        })
        applyChunkReply(reply, active.partialDisplayedSeq === active.partialSeq)
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        if (store.error.indexOf('语音模型尚未下载') !== -1) store.speech = { ...store.speech, ready: false }
      } finally {
        active.inflight = false
        if (store.active === active) {
          store.phase = active.stopping ? 'transcribing' : 'recording'
        }
        if (!active.stopping && shouldFlush(active)) void flush(active)
        store.emit()
      }
    }

    /**
     * Whether the open cue has enough NEW audio to be worth a partial pass.
     * Checked on every worklet block; one partial is in flight at most.
     * Committing the previous cue never gates this independent live lane.
     * @param active - Capture session.
     */
    function shouldPartial(active) {
      if (active.partialBusy || active.stopping || active.paused) return false
      // Noise-only buffers never reach the recognizer — same contract as flush.
      if (active.voicedSeconds < VAD.minSpeechSeconds) return false
      const cueSeconds = active.frames / active.audio.sampleRate
      if (cueSeconds < PARTIAL.minSeconds) return false
      return active.frames - active.partialAt >= PARTIAL.everySeconds * active.audio.sampleRate
    }

    /**
     * Transcribe the open cue's buffer so far and show it as the ghost line.
     * Latest-wins: a reply is displayed only when no newer partial (and no settled
     * cue) superseded it while the model ran. Failures are silent — the settled
     * /chunk right behind this call surfaces anything real.
     * @param active - Capture session.
     */
    async function sendPartial(active) {
      active.partialBusy = true
      active.partialAt = active.frames
      const sequence = active.partialSeq
      const pcm = pendingPcm(active)
      const controller = new AbortController()
      active.partialAbort = controller
      try {
        const reply = await recognizeLive(active, pcm, controller.signal)
        if (store.active === active && !controller.signal.aborted && active.partialSeq === sequence) {
          active.partialDisplayedSeq = sequence
          store.partial = typeof reply.text === 'string' ? reply.text : ''
          store.emit()
        }
      } catch {
        // Best effort only; keep the last shown text until the settled line lands.
      } finally {
        active.partialBusy = false
        if (active.partialAbort === controller) active.partialAbort = null
      }
    }

    /** Release capture resources held by the current meeting. */
    async function release() {
      const active = store.active
      if (active === null) return
      store.active = null
      // The live line belongs to the capture: it never outlives the session.
      active.partialAbort?.abort()
      if (store.partial !== '') store.partial = ''
      try {
        clearInterval(active.ticker)
        active.node.port.onmessage = null
        active.node.disconnect()
        active.sink.disconnect()
        for (const source of active.sources) source.disconnect()
        if (active.injected !== null && active.injected !== undefined) active.injected.stop()
        for (const stream of active.streams) stream.getTracks().forEach((track) => track.stop())
        if (active.url !== '') URL.revokeObjectURL(active.url)
        await active.audio.close()
      } catch (failure) {
        console.warn('meeting-notes: release failed', failure)
      }
    }

    /**
     * Names that mark an input device as a loopback (virtual sound card): capturing
     * it records what the computer is playing — the other side of an online meeting,
     * a video, a system notification. macOS has no built-in loopback, so people
     * install BlackHole & friends; Windows exposes Stereo Mix on some drivers.
     */
    const LOOPBACK_RE = /blackhole|loopback|soundflower|aggregate|stereo\s*mix|virtual\s*audio|system\s*audio|ishowu|screen\s*capture|record(?:ing)?\s*audio|内部|内录|系统声/iu

    /**
     * Remote-control and screen-casting drivers leave input devices whose names
     * sound like loopbacks ("OrayVirtualAudioDevice" matches `virtual audio`)
     * but carry the FAR side of a remote session, never this computer's own
     * playback. Capturing one "succeeds", adds a silent stream, the panel shows
     * no note — and the meeting quietly records no system sound at all while
     * believing it did (observed live: 向日葵 Oray on a machine without a real
     * loopback, others in a video meeting reached the record only through the
     * microphone picking up the speakers).
     */
    const REMOTE_DRIVER_RE = /oray|sunlogin|向日葵|todesk|parrot|eshare|anyviewer|rustdesk|airdroid/iu

    /**
     * Whether one enumerated input device can carry the computer's own audio.
     * @param device - One enumerateDevices() entry.
     */
    function isLoopbackDevice(device) {
      if (typeof device.label !== 'string') return false
      return !REMOTE_DRIVER_RE.test(device.label) && LOOPBACK_RE.test(device.label)
    }

    /**
     * Outputs that mean headphones: when one of them is the default, the far side
     * of a meeting cannot leak into the microphone, so losing the system source is
     * losing the far side entirely — the note has to say that much stronger.
     */
    const HEADPHONE_OUTPUT_RE = /airpods|耳机|headphone|headset|earphone|蓝牙|bluetooth/iu

    function defaultOutputIsHeadphones() {
      const outputs = store.outputDevices ?? []
      const def = outputs.find((device) => device.deviceId === 'default') ?? outputs[0]
      return typeof def?.label === 'string' && HEADPHONE_OUTPUT_RE.test(def.label)
    }

    /**
     * Refresh the input-device list so capture can find a loopback device. Labels
     * stay empty until the first microphone permission is granted — the next
     * refresh (devicechange, dialog open, each start) then sees the names.
     */
    async function refreshInputDevices() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        store.inputDevices = devices.filter((device) => device.kind === 'audioinput')
        store.outputDevices = devices.filter((device) => device.kind === 'audiooutput')
        store.emit()
      } catch {
        // Enumeration is optional: without it the display-capture path is tried.
      }
    }

    /**
     * Attach the host's native system capture (a Core Audio process tap — no
     * driver; system audio consent required) to this meeting's mixing node. The host streams
     * base64 PCM over one SSE response; each chunk becomes a
     * render-quantum-sized push into the inject worklet, which keeps the graph —
     * and therefore the cues — exactly as they are for the microphone. Silence
     * adds no bytes: the tap's IO cycle only runs while the machine plays
     * something, and an idle stretch is simply a gap between chunks.
     * @param meetingId - Meeting whose host capture to attach.
     * @param audio - Capture context.
     * @param node - Mixing worklet node the injected audio joins.
     * @returns a handle to stop the stream, or null when the host has none.
     */
    async function openHostCapture(meetingId, audio, node) {
      let inject
      try {
        inject = new AudioWorkletNode(audio, 'meeting-notes-inject', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        })
      } catch {
        return null
      }
      const controller = new AbortController()
      const handle = {
        stop() {
          controller.abort()
          try { inject.disconnect() } catch { /* already gone */ }
        },
      }
      // The attach loop runs in the BACKGROUND: the host side may still be
      // starting (a FIRST run compiles the helper for about a minute), and the
      // microphone must never wait for that. 40 tries × 1.5s keeps attaching
      // while the meeting records; the stream lands mid-meeting the moment it
      // is ready.
      void (async () => {
        let response = null
        for (let attempt = 0; attempt < 40; attempt++) {
          if (controller.signal.aborted) return
          try {
            response = await fetch(`${PREFIX}/system-audio?meetingId=${encodeURIComponent(meetingId)}`, { signal: controller.signal })
          } catch {
            response = null
          }
          if (response !== null && response.ok) break
          if (response !== null) {
            try { response.body?.cancel?.() } catch { /* best effort */ }
            response = null
          }
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
        if (response === null) {
          // The stream never came up: name the fixable cause (permission) on
          // the panel while this meeting is still the live one.
          void post('/audio-debug', { stage: 'sse-unavailable', meetingId }).catch(() => undefined)
          if (store.active !== null && store.active.node === node) {
            store.note = await systemSourceNote()
            store.emit()
          }
          return
        }
        void post('/audio-debug', { stage: 'sse-open', meetingId }).catch(() => undefined)
        inject.connect(node)
        let delivered = 0
        let lastLevelAt = 0
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let cut = buffer.indexOf('\n\n')
            while (cut !== -1) {
              const frame = buffer.slice(0, cut)
              buffer = buffer.slice(cut + 2)
              const event = /^event: (\w+)/m.exec(frame)?.[1] ?? ''
              if (event === 'ready') {
                // The tap graph is armed. No PCM flows until the machine actually
                // plays something (silence adds no bytes), so the badge must read
                // "attached" from here, not from the first chunk.
                store.systemAttached = true
                store.systemLevelDb = -100
                store.emit()
              } else if (event === 'pcm') {
                if (delivered === 0) void post('/audio-debug', { stage: 'first-pcm', meetingId }).catch(() => undefined)
                delivered += 1
                const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
                const samples = decodePcm(data)
                if (samples !== null) {
                  inject.port.postMessage(samples, [samples.buffer])
                  // The toolbar badge shows this stream's own level, so "music is
                  // playing but nothing reaches the record" is visible at a glance.
                  let sum = 0
                  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
                  const rms = Math.sqrt(sum / Math.max(1, samples.length))
                  store.systemAttached = true
                  store.systemLevelDb = 20 * Math.log10(Math.max(rms, 1e-5))
                  if (Date.now() - lastLevelAt > 250) {
                    lastLevelAt = Date.now()
                    store.emit()
                  }
                }
              } else if (event === 'end') {
                // The host stream died. Only worth a note while THIS capture is
                // still the live one — a stop tears everything down at once.
                if (delivered > 0 && store.active !== null && store.active.node === node) {
                  store.note = t9n('systemEnded')
                  store.emit()
                } else if (delivered === 0 && store.active !== null && store.active.node === node) {
                  // Started, then failed without ever delivering audio: name the
                  // recoverable cause (helper not built) on the panel.
                  store.note = await systemSourceNote()
                  store.emit()
                }
                store.systemAttached = false
                store.systemLevelDb = -80
                store.emit()
                return
              }
              cut = buffer.indexOf('\n\n')
            }
          }
        } catch (failure) {
          // Aborted on stop, or the stream dropped: the microphone keeps going.
          if (!controller.signal.aborted) {
            void post('/audio-debug', { stage: 'sse-error', meetingId, message: failure instanceof Error ? failure.message : String(failure) }).catch(() => undefined)
          }
        }
      })()
      return handle
    }

    /**
     * Base64 s16le -> Float32 samples for the inject worklet.
     * @param base64 - One PCM chunk.
     */
    function decodePcm(base64) {
      if (base64 === '') return null
      const raw = atob(base64)
      const length = raw.length >> 1
      if (length === 0) return null
      const out = new Float32Array(length)
      for (let i = 0; i < length; i++) {
        const low = raw.charCodeAt(i * 2)
        const high = raw.charCodeAt(i * 2 + 1)
        let value = (high << 8) | low
        if (value > 32767) value -= 65536
        out[i] = value / 32768
      }
      return out
    }

    /**
     * Open the computer's own audio (system sound) to mix into the recording —
     * no setting involved: every meeting records the microphone AND whatever the
     * machine is playing when both can be had.
     *
     * The host's native tap comes first: it needs no driver, no output switch
     * and requires system audio recording consent. A machine whose host cannot provide it falls
     * through to a loopback input device (BlackHole & friends), which records
     * whatever is played into it. Neither being possible is a note on the
     * panel, never a failed recording.
     * @returns the stream and a note naming whatever could not be had.
     */
    async function openSystemSource() {
      // The freshest device list: a loopback installed moments ago should work now.
      await refreshInputDevices()
      const loopback = store.inputDevices.find(isLoopbackDevice)
      if (loopback !== undefined) {
        try {
          const loop = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: loopback.deviceId }, echoCancellation: false, noiseSuppression: false },
          })
          return { stream: loop, note: '' }
        } catch {
          // A loopback that will not open falls through to the note below.
        }
      }
      // Nothing worked: say exactly how to get system sound onto the record —
      // the host knows whether its native capture is merely missing the
      // toolchain, which reads very differently from a tap that failed here.
      return { stream: null, note: await systemSourceNote() }
    }

    /**
     * The note shown when no system source could be opened. Asks the host what
     * its native capture can do here: an unbuilt helper (missing toolchain)
     * reads very differently from a tap that just failed to come up.
     */
    async function systemSourceNote() {
      let capability = {}
      try {
        capability = (await get('/audio-source')).capture ?? {}
      } catch {
        // A host half from before the route: fall back to the generic notes.
      }
      store.noteSource = capability.helper === 'unavailable' ? 'helper' : ''
      if (capability.platform === 'win32' || capability.backend === 'wasapi') return t9n('systemWindowsUnavailable')
      return capability.helper === 'unavailable'
        ? t9n('systemUnavailable')
        : (defaultOutputIsHeadphones() ? t9n('systemMissingHeadphones') : t9n('systemUnavailable'))
    }

    /**
     * Open the microphone and attach it to a meeting the host already has open for capture.
     * `start()` (a new meeting) and `resumeMeeting()` (the one that just stopped) both land
     * here, so the permission prompt, the worklet and the flush loop exist exactly once.
     * Nothing is configured: the default microphone is always captured, and the
     * computer's own audio (system sound) joins it whenever a source for it exists —
     * a permission that cannot be had becomes a note on the panel, never a failed
     * recording that worked before.
     * @param created - host reply to /start or /resume.
     * @param options - `continue`: keep the segments and the clock this meeting already has.
     */
    async function beginCapture(created, options) {
      const continuing = options?.continue === true
      let audio
      try {
        audio = new AudioContext({ sampleRate: TARGET_RATE })
      } catch {
        audio = new AudioContext()
      }
      await audio.resume()
      // The worklet module and the mixing node exist before any source opens: the
      // host's native capture feeds into this graph, so there must be somewhere to
      // inject it even when the microphone is the only device stream.
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
      await audio.audioWorklet.addModule(url)
      const node = new AudioWorkletNode(audio, 'meeting-notes-capture')
      const sink = audio.createGain()
      sink.gain.value = 0
      node.connect(sink)
      sink.connect(audio.destination)
      const streams = []
      let micErrorNote = ''
      try {
        streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }))
      } catch (failure) {
        const nm = failure && typeof failure.name === 'string' ? failure.name : ''
        if (nm === 'NotAllowedError' || nm === 'PermissionDeniedError') micErrorNote = '无法访问麦克风：请在系统设置里允许 DeepSeek Harness 使用麦克风'
        else if (nm === 'NotFoundError') micErrorNote = '没有检测到麦克风设备'
        else micErrorNote = `无法启动麦克风: ${failure instanceof Error ? failure.message : String(failure)}`
      }
      // Opening a BLUETOOTH headset's microphone makes macOS switch the whole
      // headset to its call profile — music turns loud and boomy, the "sound
      // changed when I started recording" surprise. The OS does this for every
      // app that opens the mic; naming it here at least explains the change.
      const micLabel = streams[0]?.getAudioTracks()?.[0]?.label ?? ''
      const bluetoothMic = /airpods|bluetooth|蓝牙|buds|linkbuds|freebuds|soundlink|powerbeats|solo\b|studio\b|wh-\d|wf-\d/iu.test(micLabel)
      if (streams.length > 0 && bluetoothMic) micErrorNote = micErrorNote === '' ? t9n('bluetoothMicNote') : micErrorNote
      // The far side, in order of preference: the host's native capture (no
      // driver; system audio consent required), then a loopback sound card. Either is
      // independent of the microphone: the computer's own playback alone is
      // still a meeting.
      let injected = null
      // Anything but an explicit "no capture" still gets the attach attempt: the
      // host reply may predate the stream, and the retry loop covers that.
      if (created.audio?.system !== 'none') injected = await openHostCapture(created.meetingId, audio, node)
      const system = injected === null ? await openSystemSource() : { stream: null, note: '' }
      if (system.stream !== null) streams.push(system.stream)
      if (streams.length === 0 && injected === null) {
        await audio.close().catch(() => undefined)
        throw new Error(micErrorNote !== '' ? micErrorNote : (system.note !== '' ? `${system.note}` : '没有可用的录音来源'))
      }
      const sources = streams.map((stream) => {
        const source = audio.createMediaStreamSource(stream)
        source.connect(node)
        return source
      })
      // A host-side capture can end on its own (picker closed, stream revoked): say so
      // instead of looking like silence for the rest of the meeting.
      for (const track of (system.stream ?? new MediaStream()).getAudioTracks()) {
        track.onended = () => {
          if (store.active === null || store.active.node !== node) return
          store.note = t9n('systemEnded')
          store.emit()
        }
      }

      const priorSeconds = typeof created.seconds === 'number' ? created.seconds : 0
      const active = {
        meetingId: created.meetingId,
        audio, streams, sources, node, sink, url,
        injected,
        pending: [],
        frames: 0,
        captured: continuing ? Math.round(priorSeconds * audio.sampleRate) : 0,
        ticker: 0,
        // Adaptive endpointing state: a per-meeting noise floor plus the speech
        // bookkeeping the flush decision reads (see observeBlock). Starts low and
        // sensitive — a quiet opening (music already playing, a soft voice) must be
        // caught from the first block; only sustained room noise lifts the floor.
        noiseFloor: 0.002,
        inSpeech: false,
        voicedSeconds: 0,
        trailingSilence: 0,
        inflight: false,
        stopping: false,
        paused: false,
        // Live-partial bookkeeping: one request at most, the frame count it was
        // armed at, a latest-wins sequence, and its abort handle.
        partialBusy: false,
        partialAt: 0,
        partialSeq: 0,
        partialAbort: null,
      }
      store.active = active
      node.port.onmessage = (event) => {
        if (active.paused === true) return
        const block = event.data
        active.pending.push(block)
        active.frames += block.length
        active.captured += block.length
        observeBlock(active, block)
        if (!active.inflight && shouldFlush(active)) void flush(active)
        else if (shouldPartial(active)) void sendPartial(active)
      }
      active.ticker = setInterval(() => {
        if (active.paused === true) return
        store.seconds = Math.round(active.captured / active.audio.sampleRate)
        store.emit()
      }, 1000)
      store.paused = false
      store.pausedAt = 0
      store.pauseWarned = false
      if (continuing) {
        store.seconds = Math.round(priorSeconds)
      } else {
        store.segments = []
        store.seconds = 0
        store.startedAt = created.startedAt ?? Date.now()
        store.points = []
        store.tasks = []
        store.labels = []
        store.speakers = {}
        store.suggestions = []
        store.documents = []
        // A fresh recording starts unnamed: the previous meeting's name (auto or
        // hand-set) must not leak into the new one's default-named field.
        store.meta = { ...store.meta, title: '' }
        store.titleDraft = null
      }
      store.meetingId = created.meetingId
      store.audioName = typeof created.audioName === 'string' ? created.audioName : ''
      store.phase = 'recording'
      // A source that could not be opened must not look like it is being recorded.
      store.note = [micErrorNote, system.note].filter((part) => part !== '').join('；') || ''
      store.emit()
    }

    /**
     * Follow the speech model readiness until it settles, updating the store. One loop
     * at a time: `speechWatchLive` keeps a second caller from stacking a second poll.
     */
    async function watchSpeech() {
      if (speechWatchLive) return
      speechWatchLive = true
      try {
        for (;;) {
          let state
          try {
            const reply = await get('/speech')
            state = { ready: reply.ready === true, phase: reply.phase, message: reply.message ?? '', busy: reply.busy === true, completedBytes: reply.completedBytes ?? 0, totalBytes: reply.totalBytes ?? 0 }
          } catch {
            state = { ready: false, phase: 'unavailable', message: '', busy: false, completedBytes: 0, totalBytes: 0 }
          }
          store.speech = { ready: state.ready, phase: state.phase, requesting: state.busy, completedBytes: state.completedBytes, totalBytes: state.totalBytes }
          // A ready model fires a pending start at once (below), so emit first.
          store.emit()
          if (state.ready) {
            if (store.pendingStart && store.phase === 'idle' && store.active === null) {
              store.pendingStart = false
              const again = store.pendingResume
              store.pendingResume = false
              void (again ? resumeMeeting() : start())
            }
            return
          }
          if (!state.busy) {
            // A model that will never become ready must not leave a pending start armed.
            if (store.pendingStart && (state.phase === 'missing' || state.phase === 'unavailable' || state.phase === 'failed')) {
              store.pendingStart = false
              store.pendingResume = false
              store.error = state.phase === 'missing'
                ? '宿主路由未注册：请重启 Harness 或更新本插件'
                : (state.message !== '' ? state.message : '语音模型准备失败')
              store.emit()
            }
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      } finally {
        speechWatchLive = false
      }
    }

    /**
     * Enable the voice-input capability if needed and download the speech model, then
     * follow its progress; a pending start fires the moment it reports ready.
     */
    async function prepareSpeech() {
      store.speech = { ...store.speech, requesting: true }
      store.emit()
      try {
        await post('/speech/prepare', {})
      } catch {
        // The route reports its own state; the watcher surfaces it.
      }
      await watchSpeech()
    }

    /** Start a new meeting and begin capture. */
    async function start() {
      store.error = ''
      store.note = ''
      if (store.speech.ready !== true) {
        store.pendingResume = false
        store.pendingStart = true
        store.emit()
        void prepareSpeech()
        return
      }
      if (store.sessionId === '') {
        store.error = '还没有可用的会话：请先打开一个对话。'
        store.emit()
        return
      }
      store.phase = 'starting'
      store.emit()
      try {
        const auto = store.autoStart === true
        store.autoStart = false
        const created = await post('/start', { sessionId: store.sessionId, terms: store.termsText, auto })
        store.stoppedAt = 0
        store.viewed = null
        await beginCapture(created, {})
      } catch (failure) {
        await release()
        store.phase = 'idle'
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
      }
    }

    /**
     * Continue the meeting that just stopped: the one-click way back from a mistaken
     * stop. The microphone reopens, the audio keeps appending to the same WAV and the
     * cues continue on the same timeline.
     */
    async function resumeMeeting() {
      if (store.meetingId === '') return
      store.error = ''
      store.note = ''
      if (store.speech.ready !== true) {
        store.pendingResume = true
        store.pendingStart = true
        store.emit()
        void prepareSpeech()
        return
      }
      store.phase = 'starting'
      store.emit()
      try {
        const created = await post('/resume', { meetingId: store.meetingId })
        store.stoppedAt = 0
        await beginCapture(created, { continue: true })
      } catch (failure) {
        await release()
        store.phase = 'idle'
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
      }
    }

    /** Stop capture, drain the remaining audio, then finalize the meeting. */
    async function stop() {
      const active = store.active
      if (active === null) return
      active.stopping = true
      store.summaryDelivery = null
      store.paused = false
      store.pausedAt = 0
      store.phase = 'transcribing'
      const startedAt = Date.now()
      const showProgress = (done = false) => {
        store.finishing = {
          remaining: active.inflight ? active.pending.length + 1 : active.pending.length,
          seconds: Math.round((Date.now() - startedAt) / 1000),
          done,
        }
        store.emit()
      }
      showProgress()
      const ticker = setInterval(showProgress, 1000)
      try {
        for (let attempt = 0; attempt < 120 && (active.inflight || active.pending.length > 0); attempt++) {
          if (active.inflight) {
            await new Promise((resolve) => setTimeout(resolve, 200))
          } else {
            await flush(active)
          }
        }
        await release()
        // A failed notes save must not leave the microphone or WAV writer running.
        await post('/notes', { meetingId: active.meetingId, text: store.notesText }).catch((error) => {
          store.error = `笔记保存失败（录音会继续完成保存）：${error.message}`
        })
        const reply = await post('/stop', { meetingId: active.meetingId })
        store.summaryDelivery = reply.summaryCard ?? null
        if (reply.summaryCard?.error) store.error = `录音已保存，但自动会话创建/总结失败：${reply.summaryCard.error}`
        applyChunkReply(reply)
        store.audioRev += 1
        showProgress(true)
        store.stoppedAt = Date.now()
        setTimeout(() => { store.finishing = null; store.emit() }, 2500)
      } catch (failure) {
        store.finishing = null
        store.stoppedAt = 0
        store.error = failure instanceof Error ? failure.message : String(failure)
      } finally {
        clearInterval(ticker)
      }
      store.phase = 'idle'
      store.emit()
      if (store.summaryDelivery?.sessionId && !store.summaryDelivery.error && store.error === '' && workspaceApi) {
        set({ open: false })
        workspaceApi.openSession(store.summaryDelivery.sessionId)
      }
    }

    /**
     * Pause or resume capture without ending the meeting. Pause means "stop
     * capturing", not "keep capturing and throw it away": the track is switched off,
     * which also releases the microphone indicator.
     */
    function togglePause() {
      const active = store.active
      if (active === null) return
      const next = active.paused !== true
      active.paused = next
      try {
        for (const stream of active.streams) for (const track of stream.getAudioTracks()) track.enabled = !next
      } catch { /* a closed stream has nothing to switch off */ }
      if (next) {
        active.pending.length = 0
        // A paused meeting shows no live line: drop the partial and its request.
        active.partialAbort?.abort()
        active.partialSeq += 1
        store.partial = ''
      }
      set({ paused: next, pausedAt: next ? Date.now() : 0, pauseWarned: false })
    }

    /**
     * Adopt this session's meeting from the host. The store keeps no durable state, so
     * after a reload this is the only way it learns which meeting it is looking at.
     * @returns whether a meeting was found.
     */
    async function adopt() {
      if (store.sessionId === '') return null
      try {
        const value = await get(`/current?sessionId=${encodeURIComponent(store.sessionId)}`)
        if (value.meeting === null) return null
        const meeting = value.meeting
        store.meetingId = meeting.meetingId
        store.startedAt = meeting.startedAt
        store.seconds = meeting.seconds
        store.segments = meeting.segments
        store.audioName = meeting.audioName ?? ''
        store.points = meeting.points
        store.tasks = meeting.tasks
        store.labels = Array.isArray(meeting.labels) ? meeting.labels : []
        store.suggestions = Array.isArray(meeting.suggestions) ? meeting.suggestions : []
        store.speakers = meeting.speakers !== null && typeof meeting.speakers === 'object' ? meeting.speakers : {}
        store.documents = Array.isArray(meeting.documents) ? meeting.documents : []
        store.meta = {
          title: typeof meeting.title === 'string' ? meeting.title : '',
          summary: typeof meeting.summary === 'string' ? meeting.summary : '',
        }
        if (typeof meeting.terms === 'string' && meeting.terms !== '') store.termsText = meeting.terms
        store.emit()
        return meeting
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
        return null
      }
    }

    /**
     * Pull the stored cues, points, and tasks — including ones the agent wrote.
     * @param meetingId - the meeting to read; defaults to the store's own.
     */
    async function refreshAnalysis(meetingId = '') {
      let id = meetingId || store.meetingId
      if (id === '') {
        const adopted = await adopt()
        if (adopted === null) return undefined
        id = adopted.meetingId
      }
      try {
        const value = await get(`/state?meetingId=${encodeURIComponent(id)}`)
        applyChunkReply(value)
        store.meta = {
          title: typeof value.title === 'string' ? value.title : '',
          summary: typeof value.summary === 'string' ? value.summary : '',
        }
        store.documents = Array.isArray(value.documents) ? value.documents : []
        store.suggestions = Array.isArray(value.suggestions) ? value.suggestions : []
        store.emit()
        return { points: store.points, tasks: store.tasks }
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
        return undefined
      }
    }

    /**
     * Make sure this panel has a meeting to store points and tasks in. A panel that
     * never recorded still gets a container, so writing a point before pressing start
     * works and the later recording joins the same record. The host hands back the
     * session's never-recorded container, or a NEW one once its last recording has
     * ended — a finished meeting is history and must not swallow a fresh panel's
     * points (or lend it its transcript through `adopt`).
     * @returns the meeting id, or an empty string when there is no session.
     */
    async function ensureMeeting() {
      if (store.meetingId !== '') return store.meetingId
      if (store.sessionId === '') return ''
      try {
        const reply = await post('/ensure', { sessionId: store.sessionId, terms: store.termsText })
        if (typeof reply.meetingId === 'string' && reply.meetingId !== '') {
          store.meetingId = reply.meetingId
          store.emit()
          return reply.meetingId
        }
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
      }
      return ''
    }

    /**
     * Commit the header's edited meeting name. Trimmed, and POSTed only on a real
     * change; an empty edit clears the custom name, so the default shows again and
     * an untouched meeting can still be named by the end-of-recording summarizer.
     * A name a person typed is deliberate: the host never re-summarizes it.
     */
    async function commitTitle() {
      const draft = store.titleDraft
      if (draft === null) return
      store.titleDraft = null
      const next = draft.trim()
      if (next === store.meta.title || store.meetingId === '') {
        store.emit()
        return
      }
      try {
        const reply = await post('/title', { meetingId: store.meetingId, title: next })
        store.meta = { ...store.meta, title: typeof reply.title === 'string' ? reply.title : next }
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
      }
      store.emit()
    }

    /**
     * Confirm, edit, or remove one stored entry. Only a human reaches this path.
     * @param kind - 'point' or 'task'.
     * @param id - Entry id from the stored list.
     * @param patch - Fields to change; empty when removing.
     * @param op - 'remove' deletes the entry.
     */
    async function editEntry(kind, id, patch = {}, op = 'update') {
      const viewing = store.viewed
      if (viewing !== null) {
        store.note = '历史会议为只读。'
        store.emit()
        return
      }
      const target = await ensureMeeting()
      if (target === '') return
      try {
        const reply = await post('/analysis', { meetingId: target, kind, id, op, patch })
        store.points = Array.isArray(reply.points) ? reply.points : store.points
        store.tasks = Array.isArray(reply.tasks) ? reply.tasks : store.tasks
        store.emit()
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
      }
    }

    /**
     * One-click local extraction: the same rules the agent gets, without a model
     * round-trip. It only ever writes drafts.
     */
    async function extractNow() {
      if (store.viewed !== null) {
        store.note = '历史会议为只读。'
        store.emit()
        return
      }
      const id = await ensureMeeting()
      if (id === '') return
      try {
        const reply = await post('/extract', { meetingId: id })
        store.points = Array.isArray(reply.points) ? reply.points : []
        store.tasks = Array.isArray(reply.tasks) ? reply.tasks : []
        const count = store.points.length + store.tasks.length
        store.note = count === 0 ? '没有识别出明显的要点或行动项。可以在对话里让 Agent 精修。' : `已提取：要点 ${store.points.length} · 工作安排 ${store.tasks.length}`
        store.emit()
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
      }
    }

    /** Write the meeting up as a minutes document (Markdown, or Word via Python). */
    async function writeMinutes(format = 'md') {
      const id = store.viewed !== null ? store.viewed.meetingId : await ensureMeeting()
      if (id === '') return
      try {
        const reply = await post('/minutes', { meetingId: id, format })
        store.note = `${format === 'docx' ? 'Word 已导出' : '纪要已生成'}: ${reply.name}`
        store.emit()
        downloadArtifact(reply.name)
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
      }
    }

    /** Save this whole meeting as one archive another DSH can open. */
    async function savePackage() {
      const id = store.viewed !== null ? store.viewed.meetingId : await ensureMeeting()
      if (id === '') return
      store.note = '正在打包这场会议 …'
      store.emit()
      try {
        const response = await fetch(`${PREFIX}/package?meetingId=${encodeURIComponent(id)}`)
        if (!response.ok) throw new Error(`${response.status}`)
        const blob = await response.blob()
        const name = fileNameFrom(response.headers.get('Content-Disposition')) ?? `${store.meta.title === '' ? id : store.meta.title}.zip`
        saveBlob(blob, name)
        store.note = `已保存到文件: ${name}`
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        store.error = `打包失败: ${message}`
      }
      store.emit()
    }

    /**
     * Attach a real name to a voice label. The label itself never changes, so assigned
     * names survive the end-of-meeting re-clustering and stay attached to the voice.
     * @param label - Voice label such as S1.
     * @param name - The person's name; empty clears the assignment.
     */
    async function nameSpeaker(label, name) {
      // Works for the meeting being recorded AND one opened from history: the label is
      // the voice's identity either way, and the rename replaces it everywhere at once.
      const id = store.viewed !== null ? store.viewed.meetingId : await ensureMeeting()
      if (id === '') return
      try {
        const reply = await post('/speaker/name', { meetingId: id, label, name })
        if (reply.speakers !== null && typeof reply.speakers === 'object') store.speakers = reply.speakers
        if (Array.isArray(reply.segments)) store.segments = reply.segments
        if (Array.isArray(reply.labels)) store.labels = reply.labels
        store.suggestions = store.suggestions.filter((item) => !(item.label === label && item.name === name))
        store.emit()
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
      }
    }

    /**
     * Re-identify the whole meeting from its recording: the repair path for cues the
     * online pass missed (the voice model was still downloading, or its worker died).
     */
    async function relabelRecording() {
      const id = store.viewed !== null ? store.viewed.meetingId : await ensureMeeting()
      if (id === '') return
      try {
        const reply = await post('/relabel', { meetingId: id })
        if (Array.isArray(reply.segments)) store.segments = reply.segments
        if (reply.speakers !== null && typeof reply.speakers === 'object') store.speakers = reply.speakers
        if (Array.isArray(reply.labels)) store.labels = reply.labels
        store.note = `重识别完成${typeof reply.judged === 'number' ? ` · ${reply.judged}` : ''}`
        store.emit()
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
      }
    }

    /**
     * Follow speaker-model readiness once, auto-preparing on a clean install; the
     * status lives in the store so the dialog and the settings share it.
     */
    async function settleSpeakers() {
      try {
        const value = await get('/speaker')
        store.speakerModel = { phase: value.phase, message: value.message ?? '', completedBytes: value.completedBytes ?? 0, totalBytes: value.totalBytes ?? 0 }
        store.emit()
        if (value.phase === 'unprepared') {
          await post('/speaker/prepare', {}).catch(() => undefined)
          return
        }
        if (value.phase === 'downloading') {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          await settleSpeakers()
        }
      } catch {
        // The status line keeps its previous value; recording is unaffected.
      }
    }

    /** Load one slice of the history list; scrolling to the bottom asks for the next. */
    async function loadHistory(query, append = false) {
      store.history = { ...store.history, loading: !append, loadingMore: append, rows: append ? store.history.rows : [] }
      store.emit()
      try {
        const offset = append ? store.history.rows.length : 0
        const reply = await get(`/history?query=${encodeURIComponent(query)}&limit=30&offset=${offset}`)
        const incoming = Array.isArray(reply.meetings) ? reply.meetings : []
        store.history = {
          ...store.history,
          rows: append ? [...store.history.rows, ...incoming] : incoming,
          total: typeof reply.total === 'number' ? reply.total : incoming.length,
          loading: false,
          loadingMore: false,
        }
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.history = { ...store.history, loading: false, loadingMore: false }
      }
      store.emit()
    }

    /**
     * Open one historical meeting in the SAME right-side pane the conversation's
     * summary card opens — one viewer, one design (tabs, custom player, search,
     * export). The modal closes only after the pane accepts the resource, so a
     * host without the right-side service still gets the in-dialog viewer below.
     * @param row - one history row ({meetingId, sessionId, title}).
     */
    async function openHistorical(row) {
      try {
        openMeetingDetails(row.meetingId)
        set({ open: false, historyOpen: false })
        return
      } catch {
        // No right-side pane service (older host): fall through to the dialog viewer.
      }
      try {
        const value = await get(`/state?meetingId=${encodeURIComponent(row.meetingId)}`)
        store.stoppedAt = 0
        store.viewed = { meetingId: row.meetingId, sessionId: row.sessionId, title: typeof value.title === 'string' ? value.title : row.title }
        store.segments = Array.isArray(value.segments) ? value.segments : []
        store.seconds = typeof value.seconds === 'number' ? value.seconds : 0
        store.audioName = typeof value.audioName === 'string' ? value.audioName : ''
        store.points = Array.isArray(value.points) ? value.points : []
        store.tasks = Array.isArray(value.tasks) ? value.tasks : []
        store.documents = Array.isArray(value.documents) ? value.documents : []
        store.labels = Array.isArray(value.labels) ? value.labels : []
        store.suggestions = Array.isArray(value.suggestions) ? value.suggestions : []
        store.speakers = value.speakers !== null && typeof value.speakers === 'object' ? value.speakers : {}
        store.meta = {
          title: typeof value.title === 'string' ? value.title : row.title,
          summary: typeof value.summary === 'string' ? value.summary : '',
        }
        store.historyOpen = false
        store.tab = 'transcript'
        store.emit()
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
      }
    }

    /**
     * Delete one historical meeting's EVERY locally saved trace: the record file, the
     * recording and the export artifacts on the host, plus the in-memory entries.
     * Destructive and unrecoverable, so the click always passes a confirmation; after
     * the host agrees the list reloads, and a viewer showing that very meeting closes.
     * @param row - one history row ({meetingId, title}).
     * @param translate - the history tab's bound translator, when available.
     */
    async function deleteHistorical(row, translate) {
      const t = typeof translate === 'function' ? translate : tx
      const label = row.title === '' ? t('unnamed') : row.title
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        if (window.confirm(`${t('historyDelete')}「${label}」？${t('historyDeleteConfirm')}。${t('historyDeleteHint')}。`) !== true) return
      }
      try {
        const reply = await post('/delete', { meetingId: row.meetingId })
        if (reply.deleted !== true) {
          store.note = t('historyDeleteFailed')
          store.emit()
        }
        // The viewer may be showing the very meeting that just vanished; leave it the
        // way closeViewed does, so the panel never points at a deleted record.
        if (store.viewed !== null && store.viewed.meetingId === row.meetingId) {
          store.viewed = null
          if (!captureInFlight()) resetForFreshMeeting()
        }
        await loadHistory(store.history.query)
        if (reply.deleted === true) {
          store.note = t('historyDeleted')
          store.emit()
        }
      } catch (failure) {
        store.error = failure instanceof Error ? failure.message : String(failure)
        store.emit()
      }
    }

    /** Leave the viewer and show this session's own meeting again. */
    async function closeViewed() {
      store.viewed = null
      store.meetingId = ''
      store.emit()
      // Leaving a history view: a capture still in flight gets its panel back; an
      // otherwise-idle panel starts fresh (the session's own record is history now).
      if (!captureInFlight()) {
        resetForFreshMeeting()
        return
      }
      const adopted = await adopt()
      if (adopted === null) {
        store.segments = []
        store.points = []
        store.tasks = []
        store.emit()
      } else {
        await refreshAnalysis(adopted.meetingId)
      }
    }

    /**
     * Whether a capture of the current panel is still in flight: live (recording or
     * paused), preparing to start, or finishing its stop. While any of these hold, the
     * panel "is still around and unfinished" — reopening must RESTORE it, not reset.
     * @returns true when the current meeting has not ended yet.
     */
    function captureInFlight() {
      return store.active !== null || store.pendingStart === true || store.finishing !== null
    }

    /**
     * Reset the panel to a brand-new meeting: every reopen after the previous meeting
     * ENDED starts fresh (empty transcript, no name, zero clock). The record itself is
     * created by /start when 开始记录 is pressed; nothing is adopted from the session's
     * older, finished meetings.
     */
    function resetForFreshMeeting() {
      store.meetingId = ''
      store.segments = []
      store.points = []
      store.tasks = []
      store.documents = []
      store.labels = []
      store.suggestions = []
      store.speakers = {}
      store.meta = { title: '', summary: '' }
      store.titleDraft = null
      store.audioName = ''
      store.seconds = 0
      store.startedAt = 0
      store.stoppedAt = 0
      store.viewed = null
      store.historyOpen = false
      store.notesFor = ''
      store.notesText = ''
      store.error = ''
      store.note = ''
      store.noteSource = ''
      store.systemAttached = false
      store.systemLevelDb = -80
      // The previous meeting's delivery (and its retry button) belongs to that record,
      // not to this empty panel.
      store.summaryDelivery = null
      store.namesOpen = false
      store.namesFocus = ''
      store.emit()
    }

    /**
     * Open the record dialog. In-flight capture → RESTORE the very panel that is still
     * running (history views drop so the live recording is what returns). Otherwise the
     * panel starts a NEW meeting: the previous one has ended, so nothing of it is shown.
     * @param sessionId - the session the entry lives in, when known.
     */
    function openDialog(sessionId) {
      const inFlight = captureInFlight()
      if (typeof sessionId === 'string' && sessionId !== '' && store.sessionId !== sessionId) {
        // A capture in flight belongs to the session that started it; the panel keeps
        // following the recording, never the conversation the click came from.
        if (!inFlight) store.sessionId = sessionId
      }
      if (inFlight) {
        // Restore: leave the running panel as is; drop any history view so the live
        // meeting is what comes back, reloading its state if the view replaced it.
        if (store.viewed !== null) {
          store.viewed = null
          store.meetingId = ''
          store.emit()
          void adopt()
        }
        store.historyOpen = false
      } else {
        resetForFreshMeeting()
      }
      store.open = true
      store.emit()
      // Opening the picker is also when device labels become readable (after the
      // first permission), so refresh the list the source row offers.
      void refreshInputDevices()
      // Warm the system-sound path while the person is still setting up: the
      // helper compilation starts at host load (a first run can take
      // about a minute), so the next recording captures the far side directly.
      void get('/audio-source').catch(() => undefined)
      if (store.speech.phase === 'checking') void watchSpeech()
      if (store.speakerModel.phase === 'unprepared') void settleSpeakers()
    }

    // Keep the terminology list in local storage and mirrored to the meeting.
    function syncTerms() {
      try {
        localStorage.setItem(TERMS_KEY, store.termsText)
      } catch {
        // Storage refused (private mode): the list still applies to this meeting.
      }
      if (store.meetingId !== '') {
        void post('/terms', { meetingId: store.meetingId, terms: store.termsText }).catch(() => undefined)
      }
    }

    /**
     * Watch for a start the agent asked for (meeting_session record). The microphone
     * belongs to the browser, so this opens the dialog; the dialog's own /record poll
     * then performs the start with the same code path as the button.
     */
    let watchedStart = 0
    async function watchPendingStart() {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      let pending
      try {
        pending = await get('/pending')
      } catch {
        return
      }
      const stamp = typeof pending.request === 'number' ? pending.request : 0
      if (stamp <= 0 || stamp === watchedStart) return
      watchedStart = stamp
      if (Date.now() - stamp > 120_000) return
      openDialog(typeof pending.sessionId === 'string' ? pending.sessionId : undefined)
    }

    // ── Components ────────────────────────────────────────────────────────────

    /**
     * Catch a render failure inside the dialog so the page shows the error instead of
     * going blank; a plugin fault should be visible and reportable, never silent.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false, message: '' }
      }

      static getDerivedStateFromError(error) {
        return { failed: true, message: error instanceof Error ? error.message : String(error) }
      }

      render() {
        if (this.state.failed) {
          return h('div', { style: { padding: 16, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, [
            h('div', null, 'meeting-notes render error'),
            h('pre', { style: styles.pre }, this.state.message),
          ])
        }
        return this.props.children
      }
    }

    /** Locale fallback when the slot does not hand the component a bound `t`. */
    const tx = (key) => zh[key] ?? en[key] ?? key

    /** A 16×16 inline glyph, stroked with currentColor. */
    function Icon(props) {
      return h('svg', {
        viewBox: '0 0 16 16', width: props.size ?? 15, height: props.size ?? 15,
        'aria-hidden': true, style: { flex: '0 0 auto', display: 'block' },
      }, props.path.map((d, index) => h('path', {
        key: index, d, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      })))
    }

    const ICONS = {
      mic: ['M8 1.75a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z', 'M3.5 7.5a4.5 4.5 0 0 0 9 0', 'M8 12v2.25'],
      history: ['M8 3.5a4.5 4.5 0 1 1-4.24 3', 'M3.25 4.75l.51 1.88L5.64 6.1', 'M8 5.5V8l2 1.5'],
      close: ['M4 4l8 8M12 4l-8 8'],
      pause: ['M6 3.5v9M10 3.5v9'],
      play: ['M5.5 3.5l7 4.5-7 4.5z'],
      stop: ['M4.5 4.5h7v7h-7z'],
      doc: ['M4 2h5l3 3v9H4z', 'M9 2v3h3'],
      trash: ['M3 4.5h10', 'M6.5 4.5V3h3v1.5', 'M5 4.5l.6 8h4.8l.6-8', 'M7.2 6.8v3.9M8.8 6.8v3.9'],
    }

    /**
     * The "会议记录" chip under the composer. One click opens the record dialog only;
     * the recording begins from the dialog's own 开始 button (the agent-requested
     * start via /meeting keeps its auto-start: that request IS the explicit click).
     *
     * Space-aware label: while the composer is wide the chip reads 「🎤 会议记录」;
     * once its tool row gets narrow enough to wrap onto several lines, the chip
     * collapses to a bare mic icon (recording states keep the clock, dropping only
     * the 会议记录/已暂停 prefix). Collapse/expand uses hysteresis on the wrapping
     * container's width: collapsing frees exactly the label's width, so re-expanding
     * at the same width would just wrap again and flip-flop — the label only comes
     * back once the row grew by more than the label needs.
     * @param props - `sessionId` from the session-scoped slot, plus the bound `t`.
     */
    function MeetingDockButton(props) {
      const s = useStore()
      const t = typeof props.t === 'function' ? props.t : tx
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [compact, setCompact] = React.useState(false)
      const wrapRef = React.useRef(null)
      const measureRef = React.useRef(null)
      const compactRef = React.useRef(false)
      const latchRef = React.useRef(0)
      const latchElRef = React.useRef(null)
      React.useEffect(() => {
        if (sessionId !== '' && store.sessionId !== sessionId) {
          const inFlight = captureInFlight()
          if (!inFlight) {
            store.sessionId = sessionId
            if (store.viewed === null) {
              // Switched conversation while idle: the next open starts a NEW meeting,
              // never the older, finished record this session may still own.
              resetForFreshMeeting()
            }
          }
          // While a capture runs, the panel keeps following the recording's session.
        }
      }, [sessionId])
      const recording = s.active !== null
      const phase = s.phase
      const live = recording && !s.paused
      const fullLabel = live
        ? `${t('open')} · ${clock(s.seconds)}`
        : recording && s.paused
          ? `${t('pausedLabel')} · ${clock(s.seconds)}`
          : t('open')
      // Collapsed: idle shows the icon alone; live/paused keep the bare clock.
      const shownLabel = compact ? (recording ? clock(s.seconds) : '') : fullLabel
      // useLayoutEffect measures before paint (no text flash on collapse); plain
      // useEffect is the fallback where only a minimal React shim exists.
      const useLayoutEffect = React.useLayoutEffect || React.useEffect
      useLayoutEffect(() => {
        const wrapEl = wrapRef.current
        if (wrapEl === null || typeof ResizeObserver === 'undefined') return
        // Host DOM nodes persist across renders, so wrapEl stays the live chip
        // wrapper. The ancestor chain is re-discovered on every check — the shell
        // may mount the chip before wiring it into the row, or re-parent it —
        // and ancestors not seen before start being observed at that point.
        // Only row-like containers (flex-row / inline) expect their children on
        // ONE line, so only there does "chip top differs from a sibling's top"
        // mean the row has wrapped; column ancestors (the composer card)
        // legitimately stack and are skipped.
        const rowLike = (el) => {
          const cs = window.getComputedStyle(el)
          return cs.display.startsWith('inline') || (cs.display.includes('flex') && cs.flexDirection.startsWith('row'))
        }
        const ancestors = () => {
          const chain = []
          for (let el = wrapEl.parentElement; el !== null && chain.length < 4; el = el.parentElement) chain.push(el)
          return chain
        }
        function check() {
          if (!wrapEl.isConnected) return
          const chain = ancestors()
          chain.forEach(watch)
          const chipTop = wrapEl.getBoundingClientRect().top
          let wrappedAt = null
          for (const anc of chain) {
            if (!anc.isConnected || !rowLike(anc)) continue
            let mates = 0
            let split = false
            for (const kid of anc.children) {
              if (kid === wrapEl) continue
              const rect = kid.getBoundingClientRect()
              if (rect.height <= 0) continue
              mates += 1
              if (Math.abs(rect.top - chipTop) > 12) { split = true; break }
            }
            if (mates > 0 && split) { wrappedAt = anc; break }
          }
          if (!compactRef.current) {
            if (wrappedAt !== null) {
              latchElRef.current = wrappedAt
              latchRef.current = wrappedAt.clientWidth
              compactRef.current = true
              setCompact(true)
            }
          } else {
            // Re-expand only once the SAME wrapping container grew by more than the
            // full label's width (+ slack) — comparing a different (wider) ancestor
            // here would expand immediately and re-wrap, flip-flopping forever.
            const track = latchElRef.current
            if (track && track.isConnected) {
              const need = latchRef.current + (measureRef.current ? measureRef.current.offsetWidth : 0) + 12
              if (track.clientWidth >= need) {
                compactRef.current = false
                setCompact(false)
              }
            }
          }
        }
        const ro = new ResizeObserver(check)
        const observed = new Set()
        const watch = (el) => { if (el !== null && !observed.has(el)) { observed.add(el); ro.observe(el) } }
        watch(wrapEl)
        check()
        window.addEventListener('resize', check)
        return () => { ro.disconnect(); window.removeEventListener('resize', check) }
      }, [])
      return h('div', { ref: wrapRef, style: styles.dockWrap }, h('button', {
        type: 'button',
        className: live ? 'mn-chip mn-chip--live' : 'mn-chip',
        style: shownLabel === ''
          ? { ...styles.dockChip, ...(live ? styles.dockChipLive : null), ...styles.dockChipIcon }
          : live ? { ...styles.dockChip, ...styles.dockChipLive } : styles.dockChip,
        title: t('openHint'),
        'aria-label': t('openHint'),
        onClick: () => {
          // Open the dialog only: the recording starts from its 开始 button.
          openDialog(sessionId)
        },
      }, [
        live
          ? h('span', { key: 'dot', style: { ...styles.statusDot, background: 'var(--dsw-alias-state-error-primary)' }, className: 'mn-dot--live' })
          : h(Icon, { key: 'icon', path: ICONS.mic, size: 14 }),
        shownLabel === '' ? null : h('span', { key: 'label' }, shownLabel),
        // Always measures the FULL label (prefix included) so the expand threshold
        // stays valid even while collapsed or while the clock ticks longer.
        h('span', { key: 'measure', ref: measureRef, style: styles.dockMeasure, 'aria-hidden': true }, fullLabel),
      ]))
    }

    /** The layout service (selectPanel), captured when the plugin applies. */
    let layoutApi = null

    /** The sessions service (binding/beginSubmission), captured when the plugin applies. */
    let sessionsApi = null
    let workspaceApi = null
    let sidebarApi = null

    function openMeetingDetails(meetingId) {
      if (!sidebarApi) throw new Error('右侧内容服务尚未就绪，请刷新页面重试')
      sidebarApi.openResource(`dsh-resource://meeting-notes/${encodeURIComponent(meetingId)}`)
    }

    /** A durable chat card projected from the host-admitted meeting summary request. */
    function MeetingSummaryCard(props) {
      const id = props.node?.data?.meetingId
      const [card, update] = React.useState(null)
      const [error, fail] = React.useState('')
      React.useEffect(() => {
        let live = true
        let pending = false
        const refresh = async () => {
          if (pending) return
          pending = true
          try { const value = await get(`/state?meetingId=${encodeURIComponent(id)}`); if (live) update(value) }
          catch (e) { if (live) fail(e.message) }
          finally { pending = false }
        }
        void refresh()
        const timer = setInterval(refresh, 2000)
        return () => { live = false; clearInterval(timer) }
      }, [id])
      const ask = async (question) => {
        try {
          const binding = sessionsApi?.binding(props.sessionId)
          if (!binding) throw new Error('会话尚未就绪，请稍后重试')
          const text = `关于会议 ${id}：${question}。请先使用 meeting_read 读取原文，根据实际会议内容回答。`
          const handle = binding.session.beginSubmission({ mode: 'queue', text, attachments: [] })
          try {
            const result = await binding.session.prompt([{ type: 'text', text }], 'queue', undefined, handle.requestId)
            if (result?.ok === false) throw new Error('追问未被接受，请重试')
          } catch (error) { handle.abandon(); throw error }
          fail('')
        } catch (error) { fail(error.message) }
      }
      const running = !card || card.summaryStatus === 'running' || card.summaryStatus === 'pending'
      return h('div', { style: { padding: '12px 0', maxWidth: 560 }, 'data-meeting-summary-card': id }, [
        h('p', { key: 'intro', role: 'status', 'aria-live': 'polite', style: { fontSize: 14, lineHeight: 1.8 } }, running ? '会议总结中…' : card.summaryStatus === 'failed' ? '会议总结失败，录音和转写已保留。' : '会议纪要已生成，点击卡片在右侧查看。'),
        h('button', { key: 'card', type: 'button', className: 'mn-card', onClick: () => { try { openMeetingDetails(id); fail('') } catch (error) { fail(error.message) } },
          style: { width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16, padding: 20 },
          'aria-label': `查看会议纪要：${card?.title || '会议纪要'}` }, [
          h('span', { key: 'icon', style: { background: 'var(--dsw-alias-brand-primary)', color: '#fff', borderRadius: 10, padding: 14 } }, '✦'),
          h('span', { key: 'text', style: { display: 'grid', gap: 8, minWidth: 0 } }, [
            h('strong', { key: 'title' }, card?.title || '会议纪要'),
            h('span', { key: 'meta', style: styles.hint }, card ? `${new Date(card.startedAt).toLocaleString()} · ${clock(card.seconds)} · ${card.segments?.length ?? 0} 段转写` : '点击查看录音和纪要'),
          ]), h('span', { key: 'arrow', style: { marginLeft: 'auto' } }, '›'),
        ]),
        !running && card?.summaryStatus !== 'failed' ? h('div', { key: 'questions', style: { display: 'grid', gap: 8, marginTop: 16 } }, ['梳理这场会议的核心结论与风险', '提取所有工作安排、负责人和截止时间', '列出会议中尚待确认的问题'].map((question) => h(Btn, { key: question, style: { textAlign: 'left', justifyContent: 'flex-start', padding: '12px 16px', borderRadius: 12 }, onClick: () => { void ask(question) } }, question))) : null,
        card?.summaryStatus === 'failed' ? h('div', { key: 'retry' }, [
          h('p', { key: 'reason', role: 'alert', style: styles.error }, card.summaryError || '总结未完成'),
          h(Btn, { key: 'button', onClick: async () => {
            try { const reply = await post('/summary-retry', { meetingId: id }); if (reply.card.error) throw new Error(reply.card.error); update({ ...card, summaryStatus: 'running', summaryError: '' }); fail('') }
            catch (error) { fail(error.message) }
          } }, '重试会议总结'),
        ]) : null,
        error ? h('p', { key: 'error', role: 'alert', style: styles.error }, error) : null,
      ])
    }

    function MinutesOverview({ value }) {
      const decisions = (value.points || []).filter((point) => point.kind === 'decision')
      const risks = (value.points || []).filter((point) => point.kind === 'risk' || point.kind === 'question')
      return h('article', { className: 'mn-card', style: { borderRadius: 16, padding: 22, marginBottom: 28 } }, [
        h('h2', { key: 'title', style: { margin: '0 0 8px', fontSize: 20 } }, value.title || '会议纪要'),
        h('p', { key: 'meta', style: styles.hint }, `${new Date(value.startedAt).toLocaleDateString()} · ${clock(value.seconds)} · ${value.segments?.length || 0} 段转写`),
        h('div', { key: 'summary', style: { padding: 16, borderRadius: 10, lineHeight: 1.8, background: 'var(--dsw-alias-bg-l1)', borderLeft: '3px solid var(--dsw-alias-brand-primary)' } }, value.summary || '纪要内容正在整理，完成后自动显示。'),
        h('div', { key: 'decisions', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 16 } }, [
          h('section', { key: 'decisions', className: 'mn-card' }, [h('strong', { key: 'head' }, '核心结论'), decisions.length ? h('ul', { key: 'list', style: { margin: 0, paddingLeft: 20, lineHeight: 1.9 } }, decisions.map((item) => h('li', { key: item.id }, item.text))) : h('p', { key: 'none', style: styles.hint }, '未提及明确决策')]),
          h('section', { key: 'risks', className: 'mn-card' }, [h('strong', { key: 'head' }, '风险与待确认'), risks.length ? h('ul', { key: 'list', style: { margin: 0, paddingLeft: 20, lineHeight: 1.9 } }, risks.map((item) => h('li', { key: item.id }, item.text))) : h('p', { key: 'none', style: styles.hint }, '暂无已提取事项')]),
        ]),
        value.tasks?.length ? h('section', { key: 'tasks', style: { marginTop: 16, borderTop: '1px solid var(--dsw-alias-border-l3)', paddingTop: 16 } }, [h('strong', { key: 'head' }, '重点待办'), ...value.tasks.map((task) => h('p', { key: task.id, style: { lineHeight: 1.8, margin: '8px 0' } }, `${task.done ? '☑' : '☐'} ${task.title}　· ${task.owner || '负责人待定'}　· ${task.due || '时间待定'}`))]) : null,
      ])
    }

    /**
     * The export dialog behind the pane's 导出 button: choose WHAT leaves the meeting —
     * 原文 / 会议总结 / 会议纪要 / 音频文件 — and the format each piece travels in
     * (原文 also picks 显示信息: speaker prefixes and timestamps). One checked row
     * downloads one file; several rows arrive as a single zip built by /export-bundle.
     * Modeled on the reference design: content rows with checkboxes, the format and
     * info settings indented under a checked row, 取消/导出 at the bottom right.
     * @param props - `{ value, summaryName, busy, onClose, onExport }`.
     */
    function ExportDialog(props) {
      const value = props.value
      const hasTranscript = (value?.segments?.length ?? 0) > 0
      const hasSummary = typeof props.summaryName === 'string' && props.summaryName !== ''
      const hasMinutes = hasTranscript || (value?.points?.length ?? 0) > 0 || (value?.tasks?.length ?? 0) > 0
      const hasAudio = typeof value?.audioName === 'string' && value.audioName !== ''
      const [picked, setPicked] = React.useState({ transcript: true, summary: false, minutes: false, audio: false })
      const [formats, setFormats] = React.useState({ transcript: 'txt', summary: 'md', minutes: 'md' })
      const [info, setInfo] = React.useState({ speaker: true, timestamp: true })
      const sections = [
        { key: 'transcript', label: '原文', available: hasTranscript, formats: ['txt', 'md', 'docx'], details: true },
        { key: 'summary', label: '会议总结', available: hasSummary, formats: ['md', 'txt', 'docx'] },
        { key: 'minutes', label: '会议纪要', available: hasMinutes, formats: ['md', 'txt', 'docx'] },
        { key: 'audio', label: '音频文件', available: hasAudio },
      ]
      const toggle = (key) => setPicked((state) => ({ ...state, [key]: !state[key] }))
      const submit = () => {
        const items = []
        if (picked.transcript) items.push({ kind: 'transcript', format: formats.transcript, speaker: info.speaker, timestamp: info.timestamp })
        if (picked.summary) items.push({ kind: 'summary', format: formats.summary })
        if (picked.minutes) items.push({ kind: 'minutes', format: formats.minutes })
        if (picked.audio) items.push({ kind: 'audio' })
        if (items.length > 0) props.onExport(items)
      }
      const chosen = sections.filter((section) => section.available && picked[section.key]).length
      // The reference checkbox: a small rounded square that fills and gains a white
      // check when on, stays an empty outline when off, and dims when unavailable.
      const box = (on) => h('span', {
        'aria-hidden': true,
        style: {
          width: 18, height: 18, borderRadius: 5, flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: `1.5px solid ${on ? 'transparent' : 'var(--dsw-alias-border-l2)'}`,
          background: on ? 'var(--dsw-alias-label-primary)' : 'transparent',
        },
      }, on ? h('svg', { viewBox: '0 0 16 16', width: 12, height: 12 }, h('path', {
        d: 'M3.5 8.5l3 3 6-7', fill: 'none', stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      })) : null)
      return h('div', {
        style: { ...styles.overlay, zIndex: 4200 }, role: 'dialog', 'aria-modal': 'true', 'aria-label': '导出会议内容',
        // Clicking the dimmed area outside the card closes, like the record dialog.
        onClick: (event) => { if (event.target === event.currentTarget) props.onClose() },
      }, h('div', {
        style: {
          width: 'min(92vw, 480px)', maxHeight: '86vh', overflow: 'auto', borderRadius: 16, padding: '22px 24px',
          background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column', gap: 16,
        },
      }, [
        h('strong', { key: 'title', style: { fontSize: 16 } }, '导出'),
        h('div', { key: 'sections', style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          sections.map((section) => {
            const on = section.available && picked[section.key]
            return h('div', { key: section.key, style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
              h('div', {
                role: 'checkbox', 'aria-checked': on, 'aria-disabled': !section.available, 'aria-label': `导出${section.label}`,
                tabIndex: section.available ? 0 : -1,
                onClick: () => { if (section.available) toggle(section.key) },
                onKeyDown: (event) => {
                  if (section.available && (event.key === ' ' || event.key === 'Enter')) { toggle(section.key); event.preventDefault() }
                },
                style: {
                  display: 'flex', alignItems: 'center', gap: 10, cursor: section.available ? 'pointer' : 'default',
                  color: section.available ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-dimmed)',
                },
              }, [
                box(on),
                h('span', { key: 'label', style: { fontSize: 14, fontWeight: 600 } }, section.label),
                !section.available ? h('span', { key: 'hint', style: styles.hint }, '暂无可用内容') : null,
              ]),
              on ? h('div', { key: 'sub', style: { marginLeft: 28, display: 'flex', flexDirection: 'column', gap: 10 } }, [
                Array.isArray(section.formats) ? h('div', { key: 'format', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
                  h('span', { key: 'label', style: { ...styles.hint, flex: '0 0 auto' } }, '文件格式'),
                  h(Picker, {
                    key: 'picker', value: formats[section.key], 'aria-label': `${section.label}文件格式`,
                    onChange: (event) => setFormats((state) => ({ ...state, [section.key]: event.target.value })),
                    style: { flex: 1 },
                  }, section.formats.map((format) => h('option', { key: format, value: format }, format))),
                ]) : null,
                section.details ? h('div', { key: 'info', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
                  h('span', { key: 'label', style: { ...styles.hint, flex: '0 0 auto' } }, '显示信息'),
                  h('div', { key: 'chips', style: { display: 'flex', gap: 6, flex: 1, minWidth: 0, flexWrap: 'wrap' } },
                    [['speaker', '发言人'], ['timestamp', '时间戳']].map(([key, label]) => h('button', {
                      key, type: 'button', 'aria-pressed': info[key], title: info[key] ? `去掉${label}` : `加上${label}`,
                      onClick: () => setInfo((state) => ({ ...state, [key]: !state[key] })),
                      style: {
                        font: 'inherit', fontSize: 12, lineHeight: 1.6, padding: '2px 10px', borderRadius: 6, cursor: 'pointer',
                        border: `1px solid ${info[key] ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-border-l1)'}`,
                        borderStyle: info[key] ? 'solid' : 'dashed',
                        background: info[key] ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                        color: info[key] ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                      },
                    }, info[key] ? `${label} ×` : label))),
                ]) : null,
              ]) : null,
            ])
          })),
        h('div', { key: 'foot', style: { display: 'flex', justifyContent: 'flex-end', gap: 10 } }, [
          h(Btn, { key: 'cancel', onClick: props.onClose }, '取消'),
          h(Btn, { key: 'go', variant: 'primary', disabled: props.busy || chosen === 0, onClick: submit }, props.busy ? '导出中…' : '导出'),
        ]),
      ]))
    }

    /**
     * The shell-mounted pane body. The real seat (`sidebar.right.pane.tab`) hands the
     * registered component a `useTabInfo` hook prop — the same contract every shipped
     * tab type uses (see dsh-client-ui-sidebar-documentpreview) — and the resource
     * address lives in `tab.contentId`. The Boundary stays OUTSIDE the view so a
     * render failure shows as a visible error, never a silently blank pane.
     */
    function MeetingDetailPane(props) {
      return h(Boundary, null, h(MeetingDetailView, props))
    }

    /** Independent viewer state: never replaces an in-flight recording or its notes. */
    function MeetingDetailView({ useTabInfo }) {
      const info = typeof useTabInfo === 'function' ? useTabInfo() : null
      const id = decodeURIComponent(String(info?.tab?.contentId ?? '').split('/').pop() || '')
      const [value, update] = React.useState(null)
      const [notes, setNotes] = React.useState('')
      const [tab, select] = React.useState('transcript')
      const [error, fail] = React.useState('')
      const [documentText, setDocumentText] = React.useState('')
      const [playhead, setPlayhead] = React.useState(0)
      const [rate, setRate] = React.useState(1)
      const [playing, setPlaying] = React.useState(false)
      const [duration, setDuration] = React.useState(0)
      const [query, setQuery] = React.useState('')
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, notify] = React.useState('')
      const [exportOpen, showExport] = React.useState(false)
      // The summary conversation's seat: { sessionId, alive }. Null until the
      // one-shot /summary-session check lands; !alive is what offers reopening.
      const [summarySeat, setSummarySeat] = React.useState(null)
      const audio = React.useRef(null)
      const pendingSeek = React.useRef(null)
      const loaded = React.useRef('')
      React.useEffect(() => {
        let live = true
        let running = false
        update(null); setNotes(''); setDocumentText(''); fail(''); select('transcript'); setEditing(false); setDraft(''); setQuery(''); notify(''); loaded.current = ''
        setPlayhead(0); setPlaying(false); setDuration(0); pendingSeek.current = null
        const refresh = async () => {
          if (running) return
          running = true
          try {
            const [state, note] = await Promise.all([get(`/state?meetingId=${encodeURIComponent(id)}`), get(`/notes?meetingId=${encodeURIComponent(id)}`)])
            if (!live) return
            update(state); setNotes(note.text || ''); fail('')
            const doc = [...(state.documents || [])].reverse().find((entry) => entry.kind === 'summary') || state.documents?.at(-1)
            if (doc) {
              const reply = await get(`/file?name=${encodeURIComponent(doc.name)}`)
              if (live) { loaded.current = doc.name; setDocumentText(reply.content || '') }
            }
          } catch (e) { if (live) fail(e.message) }
          finally { running = false }
        }
        void refresh()
        const timer = setInterval(refresh, 2500)
        return () => { live = false; clearInterval(timer) }
      }, [id])
      // One aliveness check per meeting open (not per /state poll): does the
      // summary conversation this pane's card lived in still exist?
      React.useEffect(() => {
        let live = true
        setSummarySeat(null)
        void get(`/summary-session?meetingId=${encodeURIComponent(id)}`)
          .then((reply) => { if (live) setSummarySeat({ sessionId: typeof reply.sessionId === 'string' ? reply.sessionId : '', alive: reply.alive === true }) })
          .catch(() => { if (live) setSummarySeat(null) })
        return () => { live = false }
      }, [id])
      const total = duration > 0 ? duration : Math.max(0, Number(value?.seconds) || 0)
      const seek = (seconds) => {
        const el = audio.current
        if (!el || !Number.isFinite(seconds)) return
        const target = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds)
        if (el.readyState === 0) pendingSeek.current = target
        else el.currentTime = target
        setPlayhead(target)
      }
      // Play/pause for the hidden <audio>: the pane owns the whole player chrome,
      // so it must own transport too (the native controls are never rendered).
      const toggle = () => {
        const el = audio.current
        if (!el) return
        if (el.paused === false) el.pause?.()
        else {
          const started = el.play?.()
          if (started && typeof started.catch === 'function') started.catch(() => { setPlaying(false); fail('录音播放失败，请重试') })
        }
      }
      // The transcript exactly as it looked while recording: the recognizer's output
      // plus that meeting's corrections and terminology rules — the same seenOf +
      // applyRules chain the live transcript tab renders, so both views never diverge.
      const termsText = typeof value?.terms === 'string' ? value.terms : ''
      const cues = React.useMemo(
        () => applyRules(Array.isArray(value?.segments) ? value.segments : [], parseTerms(termsText).rules),
        [value?.segments, termsText],
      )
      const currentText = () => tab === 'minutes' ? documentText : tab === 'notes' ? notes : tab === 'transcript' ? cues.map((cue) => `${clock(cue.start)} ${speakerPrefixOf(cue)}${seenOf(cue)}`).join('\n') : [...(value?.points || []).map((point) => point.text), ...(value?.tasks || []).map((task) => `${task.title} · ${task.owner || '负责人待定'} · ${task.due || '时间待定'}`)].join('\n')
      const copy = async () => {
        try { await navigator.clipboard.writeText(currentText()); notify('已复制当前页内容') }
        catch { fail('复制失败，请检查剪贴板权限') }
      }
      const save = async () => {
        setBusy(true)
        try {
          if (tab === 'notes') { await post('/notes', { meetingId: id, text: draft }); setNotes(draft) }
          else { await post('/document', { meetingId: id, name: loaded.current, markdown: draft }); setDocumentText(draft) }
          setEditing(false); notify('已保存')
        } catch (error) { fail(error.message) }
        finally { setBusy(false) }
      }
      const exportItems = async (items) => {
        setBusy(true)
        try {
          const reply = await post('/export-bundle', { meetingId: id, items })
          downloadArtifact(reply.name)
          notify(`已导出：${(Array.isArray(reply.files) ? reply.files : [reply.name]).join('、')}`)
          showExport(false)
        } catch (error) { fail(error.message) }
        finally { setBusy(false) }
      }
      // The summary conversation was deleted (or never delivered): create a fresh
      // one, rerun the summary there, and open it beside this pane.
      const reopenSummary = async () => {
        setBusy(true)
        try {
          const reply = await post('/summary-reopen', { meetingId: id })
          if (reply.card.error) throw new Error(reply.card.error)
          setSummarySeat({ sessionId: typeof reply.card.sessionId === 'string' ? reply.card.sessionId : '', alive: true })
          notify('已重新开启会话总结')
          if (reply.card.sessionId && typeof workspaceApi?.openSession === 'function') workspaceApi.openSession(reply.card.sessionId)
        } catch (error) { fail(error.message) }
        finally { setBusy(false) }
      }
      const empty = (text) => h('p', { style: { ...styles.empty, padding: '64px 16px' } }, text)
      let body
      if (!value) body = empty(error ? '加载失败，请检查错误后重试' : '正在加载会议…')
      else if (tab === 'transcript') body = cues.length ? cues.filter((cue) => !query || seenOf(cue).toLowerCase().includes(query.toLowerCase())).map((cue, index) => h('button', {
        key: cue.id || index, type: 'button', disabled: !value.audioName, title: value.audioName ? tx('seekHint') : undefined, onClick: () => seek(cue.start),
        style: { display: 'grid', gridTemplateColumns: '52px 1fr', gap: 12, width: '100%', textAlign: 'left', border: 0, borderRadius: 8, padding: '14px 8px', cursor: 'pointer', color: 'inherit',
          background: playhead >= cue.start && playhead < cue.end ? 'var(--dsw-alias-bg-l1)' : 'transparent' },
      }, [h('span', { key: 'time', style: styles.hint }, clock(cue.start)), h('span', { key: 'text', style: { lineHeight: 1.8 }, title: seenOf(cue) === cue.text ? undefined : cue.text }, [
        h('strong', { key: 'speaker', style: { display: 'block', fontSize: 12 } }, value.speakers?.[cue.speaker] || cue.speaker || '发言人'), seenOf(cue),
      ])])) : empty('未检测到足够的有效内容，可能是音频过短或内容不清晰。仍可在上方播放原始录音。')
      else if (tab === 'minutes') body = documentText ? h('div', null, [h(MinutesOverview, { key: 'overview', value }), h(MarkdownText, { key: 'markdown', text: documentText, streaming: false })])
        : empty(value.summaryStatus === 'failed' ? `会议总结失败：${value.summaryError || '请点击卡片重试'}` : value.summaryStatus === 'running' || value.summaryStatus === 'pending' ? '会议总结中…完成后将在此自动显示。' : '录音信息不足，暂时无法生成可靠的 AI纪要。')
      else if (tab === 'notes') body = notes ? h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.9 } }, notes) : empty('这场会议没有记录笔记。')
      else body = h('div', { style: styles.list }, [
        ...(value.points || []).map((point) => h('div', { key: point.id, className: 'mn-card' }, [h('strong', { key: 'kind' }, tx(`point_${point.kind}`)), h('span', { key: 'text' }, point.text)])),
        ...(value.tasks || []).map((task) => h('div', { key: task.id, className: 'mn-card' }, [h('strong', { key: 'title' }, `${task.done ? '☑' : '☐'} ${task.title}`), h('span', { key: 'meta', style: styles.hint }, `${task.owner || '负责人待定'} · ${task.due || '时间待定'} · ${tx(PRIORITY_KEYS[task.priority] || 'priorityNormal')}`)])),
        !value.points?.length && !value.tasks?.length ? empty('暂无要点与工作安排；AI整理完成后会自动显示。') : null,
      ])
      return h(Boundary, null, h('section', { style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', color: 'var(--dsw-alias-text-primary)', background: 'var(--dsw-alias-bg-base)' } }, [
        h('header', { key: 'header', style: { padding: '16px 20px', borderBottom: '1px solid var(--dsw-alias-border-l3)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
          h('strong', { key: 'title', style: { flex: 1, minWidth: 120 } }, value?.title || '会议纪要'),
          editing ? h(Btn, { key: 'save', disabled: busy, variant: 'primary', onClick: () => { void save() } }, busy ? '保存中…' : '保存') : h(Btn, { key: 'edit', disabled: busy || !value || !['notes', 'minutes'].includes(tab) || (tab === 'minutes' && !loaded.current), onClick: () => { setDraft(currentText()); setEditing(true); notify('') } }, '编辑'),
          editing ? h(Btn, { key: 'cancel', disabled: busy, onClick: () => setEditing(false) }, '取消') : null,
          h(Btn, { key: 'copy', disabled: !value || editing, onClick: () => { void copy() } }, '复制'),
          h(Btn, { key: 'export', disabled: busy || !value || editing, 'aria-expanded': exportOpen, onClick: () => showExport(!exportOpen) }, '导出'),
        ]),
        exportOpen ? h(ExportDialog, {
          key: 'export-dialog', value, summaryName: loaded.current, busy,
          onClose: () => showExport(false),
          onExport: (items) => { void exportItems(items) },
        }) : null,
        // The summary conversation is gone (deleted, or its delivery never landed):
        // one slim row offers recreating it — the only path left when the chat card
        // itself vanished with the conversation. Hidden while a summary runs.
        value?.audioName && summarySeat !== null && !summarySeat.alive && summarySeat.sessionId !== '' && value.summaryStatus !== 'running' && value.summaryStatus !== 'pending'
          ? h('div', { key: 'reopen', style: { padding: '10px 20px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
            h('span', { key: 'hint', style: styles.hint }, value.summaryStatus === 'completed' ? '这场会议的总结会话已删除' : '这场会议的总结会话不可用'),
            h(Btn, { key: 'go', disabled: busy, onClick: () => { void reopenSummary() } }, '重新开启会话总结'),
          ]) : null,
        // A normal player, built from theme parts: play/pause, current time, a
        // draggable progress bar, total time, ±skips and speed. The <audio> itself
        // stays in the tree (hidden) as the media engine every control above drives.
        h('div', { key: 'player', style: { padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, value?.audioName ? [
          h('audio', { key: id, ref: audio, preload: 'metadata', src: `${PREFIX}/audio?name=${encodeURIComponent(value.audioName)}`, style: { display: 'none' },
            onLoadedMetadata: (event) => { const el = event.currentTarget; el.playbackRate = rate
              setDuration(Number.isFinite(el.duration) ? el.duration : 0)
              if (pendingSeek.current !== null) {
                el.currentTime = Number.isFinite(el.duration) ? Math.min(pendingSeek.current, el.duration) : pendingSeek.current
                pendingSeek.current = null
                setPlayhead(el.currentTime)
              }
            },
            onDurationChange: (event) => { const seconds = event.currentTarget.duration; setDuration(Number.isFinite(seconds) ? seconds : 0) },
            onTimeUpdate: (event) => { if (pendingSeek.current === null) setPlayhead(event.currentTarget.currentTime) },
            onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false),
            onError: () => fail('录音加载失败，文件可能不存在或无法播放') }),
          h(Btn, { key: 'play', variant: 'primary', title: playing ? '暂停' : '播放', 'aria-label': playing ? '暂停' : '播放', onClick: toggle,
            style: { width: 34, height: 34, borderRadius: 999, padding: 0, flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
          h(Icon, { path: playing ? ICONS.pause : ICONS.play, size: playing ? 14 : 13 })),
          h('span', { key: 'now', style: styles.clock }, clock(playhead)),
          h('input', { key: 'bar', type: 'range', min: 0, max: total, step: 'any', value: Math.min(playhead, total), disabled: total <= 0,
            'aria-label': '播放进度', 'aria-valuetext': `${clock(playhead)} / ${clock(total)}`,
            onChange: (event) => seek(Number(event.currentTarget.value)),
            onKeyDown: (event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { seek(playhead - 5); event.preventDefault() }
              else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { seek(playhead + 5); event.preventDefault() }
              else if (event.key === 'Home') { seek(0); event.preventDefault() }
              else if (event.key === 'End') { seek(total); event.preventDefault() }
            },
            style: { flex: '1 1 140px', minWidth: 140, height: 22, cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary)' } }),
          h('span', { key: 'total', style: styles.clock }, clock(total)),
          h(Btn, { key: 'back', title: '后退 15 秒', onClick: () => seek(playhead - 15) }, '−15s'),
          h(Btn, { key: 'forward', title: '前进 5 秒', onClick: () => seek(playhead + 5) }, '+5s'),
          h(Picker, { key: 'speed', value: rate, 'aria-label': '播放倍速', onChange: (event) => { const next = Number(event.target.value); setRate(next); if (audio.current) audio.current.playbackRate = next } }, [0.75, 1, 1.25, 1.5, 2].map((speed) => h('option', { key: speed, value: speed }, `${speed}×`))),
        ] : h('span', { key: 'no-audio', style: styles.hint }, !value ? (error ? '录音暂不可用。' : '正在加载录音…') : '这场会议没有录音文件。')),
        h('div', { key: 'tabs', role: 'tablist', 'aria-label': '会议内容', style: { ...styles.tabs, flexWrap: 'wrap' } }, [['transcript', '转写'], ['minutes', 'AI纪要'], ['notes', '笔记'], ['actions', '要点与工作安排']].map(([key, label]) => h(Btn, { key, role: 'tab', 'aria-selected': tab === key, variant: tab === key ? 'tab-active' : 'tab', disabled: editing, onClick: () => select(key) }, label))),
        error ? h('p', { key: 'error', role: 'alert', style: styles.error }, error) : null,
        notice ? h('p', { key: 'notice', role: 'status', style: { ...styles.hint, margin: '8px 20px' } }, notice) : null,
        tab === 'transcript' ? h('div', { key: 'search', style: { padding: '8px 20px' } }, h(Field, { value: query, placeholder: '查找转写内容', 'aria-label': '查找转写内容', onChange: (event) => setQuery(event.target.value) })) : null,
        h('div', { key: 'body', role: 'tabpanel', style: { overflow: 'auto', flex: 1, padding: 20, minHeight: 0 } }, editing ? h('textarea', { className: 'mn-field mn-field--area', value: draft, 'aria-label': tab === 'notes' ? '编辑笔记' : '编辑 AI纪要', onChange: (event) => setDraft(event.target.value), style: { width: '100%', minHeight: 360, resize: 'vertical', lineHeight: 1.8 } }) : body),
      ]))
    }

    /**
     * The left-sidebar panel icon for 会议记录 (the row right below the old plugin's
     * 会议管理): a plain mic glyph stroked with currentColor, so it follows the theme.
     * @param props - `size` from the sidebar row (16 when wide, 18 otherwise).
     */
    function MeetingNotesPanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h(Icon, { path: ICONS.mic, size })
    }

    /**
     * The launcher main page behind the sidebar entry. Clicking the entry selects this
     * panel; on mount it opens the record dialog and hands the center back to the
     * conversation in the same layout pass — so the entry behaves as "click → the
     * dialog pops up". The rendered fallback only shows if that hand-back failed.
     */
    function MeetingNotesLauncher() {
      React.useLayoutEffect(() => {
        openDialog()
        try {
          layoutApi?.selectPanel(null)
        } catch {
          // Staying here is fine: the reopen button below still works.
        }
      }, [])
      return h('div', { style: styles.launcher }, [
        h('p', { key: 'hint', style: styles.launcherHint }, tx('launcherHint')),
        h('button', {
          key: 'reopen', type: 'button', className: 'mn-btn mn-btn--primary',
          onClick: () => openDialog(),
        }, tx('openHint')),
      ])
    }

    /**
     * The right-hand notes pad of the LIVE record dialog: a PLAIN-TEXT editor. The text
     * loads once per meeting and autosaves (debounced) to /notes, so it stays with the
     * record, travels inside meeting exports, and feeds the AI summary (host-summary.js
     * passes it as a dedicated `notes` field the model must weave into the minutes).
     * The open/close toggle lives BETWEEN the two panes (see the dialog body), not
     * inside this panel.
     * @param props - the bound `t`.
     */
    function NotesPanel(props) {
      const t = typeof props.t === 'function' ? props.t : tx
      const s = useStore()
      const timer = React.useRef(0)
      React.useEffect(() => {
        const id = store.meetingId
        if (id === '' || store.viewed !== null) return
        if (store.notesFor === id) return
        // Notes typed before the record existed (fresh panel, 开始 not pressed yet)
        // carry INTO the new meeting instead of being wiped by the load below.
        const carryOver = store.notesFor === '' && store.notesText.trim() !== ''
        store.notesFor = id
        void (async () => {
          if (carryOver) {
            await post('/notes', { meetingId: id, text: store.notesText }).catch(() => undefined)
            return
          }
          try {
            const reply = await get(`/notes?meetingId=${encodeURIComponent(id)}`)
            store.notesText = typeof reply?.text === 'string' ? reply.text : ''
          } catch {
            store.notesText = ''
          }
          store.emit()
        })()
      }, [s.meetingId, s.viewed])
      React.useEffect(() => () => window.clearTimeout(timer.current), [])
      const edit = (event) => {
        const value = event.target.value
        store.notesText = value
        store.emit()
        window.clearTimeout(timer.current)
        const id = store.meetingId
        if (id === '') return
        timer.current = window.setTimeout(() => {
          void post('/notes', { meetingId: id, text: value }).catch(() => undefined)
        }, 800)
      }
      return h('div', { style: styles.notesPanel }, [
        h('div', { key: 'head', style: styles.notesHead }, [
          h('span', { key: 'title', style: styles.label }, t('notesTitle')),
        ]),
        h('textarea', {
          key: 'editor', className: 'mn-field mn-field--area', style: styles.notesEditor,
          value: s.notesText, placeholder: t('notesPlaceholder'), spellCheck: false,
          onChange: (event) => edit(event),
        }),
      ])
    }

    /**
     * The transcript tab: the audio player, the toolbar (follow, speakers, more), and
     * the timed cue list. Clicking a cue seeks the recording.
     * @param props - bound `t`.
     */
    function TranscriptTab(props) {
      const t = typeof props.t === 'function' ? props.t : tx
      const s = useStore()
      const { terms, rules } = React.useMemo(() => parseTerms(s.termsText), [s.termsText])
      const visible = React.useMemo(() => applyRules(s.segments, rules), [s.segments, rules])
      const corrected = React.useMemo(() => visible.reduce((total, segment) => total + (segment.auto === true ? 1 : 0), 0), [visible])
      const [playhead, setPlayhead] = React.useState(0)
      const [playing, setPlaying] = React.useState(false)
      const [follow, setFollow] = React.useState(true)
      const [moreOpen, setMoreOpen] = React.useState(false)
      const audio = React.useRef(null)
      const rows = React.useRef([])
      const listRef = React.useRef(null)
      const followRef = React.useRef(true)

      const activeIndex = React.useMemo(() => {
        let index = -1
        for (let i = 0; i < visible.length; i++) if (visible[i].start <= playhead) index = i
        return index
      }, [playhead, visible])

      // Background auto-corrections land between cues: while the meeting is recording,
      // a light poll keeps the visible transcript in step with the host's rewrites.
      React.useEffect(() => {
        if ((s.phase !== 'recording' && s.phase !== 'transcribing') || s.meetingId === '') return undefined
        const meetingId = s.meetingId
        const timer = setInterval(() => {
          void (async () => {
            try {
              const reply = await get(`/state?meetingId=${encodeURIComponent(meetingId)}`)
              if (store.active !== null && Array.isArray(reply.segments)) {
                // Both this poll and every /chunk reply read the host's own snapshot,
                // so whichever lands last is never a regression.
                store.segments = reply.segments
                store.emit()
              }
            } catch {
              // Between meetings or shutting down: the next poll or chunk reply recovers.
            }
          })()
        }, 5000)
        return () => clearInterval(timer)
      }, [s.phase, s.meetingId])

      React.useEffect(() => {
        if (!playing || activeIndex < 0) return
        const row = rows.current[activeIndex]
        if (row !== null && row !== undefined) row.scrollIntoView({ block: 'nearest' })
      }, [activeIndex, playing])

      React.useEffect(() => {
        if (followRef.current !== true) return
        const box = listRef.current
        if (box === null) return
        box.scrollTop = box.scrollHeight
      }, [s.segments.length, s.partial])

      React.useEffect(() => {
        if (!moreOpen) return undefined
        const close = () => setMoreOpen(false)
        const onKey = (event) => { if (event.key === 'Escape') setMoreOpen(false) }
        const timer = setTimeout(() => {
          document.addEventListener('click', close)
          document.addEventListener('keydown', onKey)
        }, 0)
        return () => {
          clearTimeout(timer)
          document.removeEventListener('click', close)
          document.removeEventListener('keydown', onKey)
        }
      }, [moreOpen])

      const seekTo = (seconds) => {
        const element = audio.current
        if (element === null) return
        element.currentTime = seconds
        setPlayhead(seconds)
        const started = element.play()
        if (started !== undefined && typeof started.catch === 'function') started.catch(() => setPlaying(false))
      }

      const copy = async (kind) => {
        try {
          const text = kind === 'srt' ? srtOf(visible)
            : kind === 'fix' ? correctionPromptOf(srtOf(visible), terms)
              // The reading format: `01:34 发言人1：内容`, one line per block.
              : visible.map((segment) => `${clock(segment.start)} ${speakerPrefixOf(segment)}${seenOf(segment)}`).join('\n')
          await navigator.clipboard.writeText(text)
          set({ note: t('copied') })
        } catch (failure) {
          set({ error: failure instanceof Error ? failure.message : String(failure) })
        }
      }

      // The open cue's live line — 边说边出字：recognized while the person is still
      // talking, then replaced (often visibly revised) by the settled cue. Live
      // recording only: a viewed history has no open cue by definition.
      const partialRow = s.viewed === null && (s.phase === 'recording' || s.phase === 'transcribing') && s.partial !== ''
        ? h('div', {
          key: 'partial', style: styles.segment, className: 'mn-partial',
          title: t('partialHint'), 'aria-live': 'polite',
        }, [
          h('span', { key: 'time', style: styles.stamp }, clock(s.seconds)),
          h('span', { key: 'text', style: styles.partialText }, [
            s.partial,
            h('span', { key: 'caret', className: 'mn-caret', 'aria-hidden': 'true' }),
          ]),
        ])
        : null

      return h(React.Fragment, null, [
        // No audio player here: the transcript panel is text only. (A finished meeting's
        // audio bar lives above the tabs while VIEWING, see the dialog body.)
        h('div', { key: 'tools', style: styles.row }, [
          h(Btn, {
            key: 'follow', type: 'button', variant: follow ? 'active' : 'ghost',
            'aria-pressed': follow,
            onClick: () => {
              const next = follow !== true
              followRef.current = next
              setFollow(next)
              if (next && listRef.current !== null) listRef.current.scrollTop = listRef.current.scrollHeight
            },
          }, t('followNewest')),
          follow ? null : h(Btn, {
            key: 'jump', type: 'button', variant: 'ghost',
            onClick: () => {
              followRef.current = true
              setFollow(true)
              if (listRef.current !== null) listRef.current.scrollTop = listRef.current.scrollHeight
            },
          }, t('jumpToNewest')),
          h('span', { key: 'count', style: styles.stamp }, `${visible.length} ${t('segments')}`),
          corrected > 0 ? h('span', {
            key: 'fixed', style: { ...styles.stamp, color: 'var(--ds-primary, #10a37f)' }, title: t('correctedHint'),
          }, `${t('corrected')} ${corrected}`) : null,
          h('span', {
            key: 'system', title: t('systemBadgeHint'),
            style: s.systemAttached ? styles.systemBadgeLive : styles.systemBadge,
          }, s.systemAttached ? `${t('systemBadgeLive')} ${Math.round(s.systemLevelDb)} dB` : t('systemBadgeOff')),
          h('span', { key: 'sp', style: styles.spacer }),
          h(Btn, {
            key: 'speakers', type: 'button', variant: 'ghost',
            onClick: () => set({ namesOpen: !store.namesOpen, namesFocus: '' }),
          }, t('speakerNames')),
          h('div', { key: 'more', style: styles.menuWrap, onClick: (event) => event.stopPropagation() }, [
            h(Btn, {
              key: 'open', type: 'button', variant: 'ghost', 'aria-expanded': moreOpen,
              onClick: () => setMoreOpen(!moreOpen),
            }, t('moreActions')),
            moreOpen ? h('div', { key: 'menu', style: styles.menu, role: 'menu' }, [
              h(Btn, {
                key: 'srt', type: 'button', variant: 'menu', role: 'menuitem',
                disabled: visible.length === 0,
                onClick: () => { setMoreOpen(false); void copy('srt') },
              }, t('copySrt')),
              h(Btn, {
                key: 'text', type: 'button', variant: 'menu', role: 'menuitem',
                disabled: visible.length === 0,
                onClick: () => { setMoreOpen(false); void copy('text') },
              }, t('copy')),
              h(Btn, {
                key: 'fix', type: 'button', variant: 'menu', role: 'menuitem',
                disabled: visible.length === 0,
                onClick: () => { setMoreOpen(false); void copy('fix') },
              }, t('copyForFix')),
              h(Btn, {
                key: 'zip', type: 'button', variant: 'menu', role: 'menuitem',
                onClick: () => { setMoreOpen(false); void savePackage() },
              }, t('exportFile')),
            ]) : null,
          ]),
        ]),
        s.namesOpen ? h(SpeakerNamesDialog, { key: 'names', t }) : null,
        visible.length === 0 && partialRow === null
          ? h('p', { key: 'empty', style: styles.empty }, t('empty'))
          : h('div', {
            key: 'list', ref: listRef, style: styles.transcriptBox,
            onScroll: (event) => {
              const box = event.currentTarget
              const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48
              followRef.current = atBottom
              setFollow(atBottom)
            },
          }, [...visible.map((segment, index) => h('div', {
            key: segment.id,
            ref: (element) => { rows.current[index] = element },
            style: index === activeIndex ? styles.segmentActive : styles.segment,
            className: 'mn-hover',
            title: t('seekHint'),
            onClick: () => seekTo(segment.start),
          }, [
            h('span', { key: 'time', style: styles.stamp }, clock(segment.start)),
            typeof segment.speaker === 'string' && segment.speaker !== ''
              ? h('button', {
                key: 'speaker', type: 'button', className: 'mn-chipbtn',
                title: t('speakerChipHint'),
                onClick: (event) => {
                  // Editing the speaker must not seek the recording (the row's own click).
                  event.stopPropagation()
                  set({ namesOpen: true, namesFocus: labelOfDisplay(store, segment.speaker) })
                },
              }, segment.speaker)
              : null,
            h('span', {
              key: 'text', style: styles.segmentText,
              title: seenOf(segment) === segment.text ? undefined : segment.text,
            }, seenOf(segment)),
          ])), partialRow])
      ])
    }

    /**
     * The speaker-names dialog: one row per identified voice — its default 发言人N label
     * with an editable name — opened from the transcript toolbar's 发言人名称编辑 button
     * or by clicking a speaker chip. Saving applies every changed name at once; the name
     * attaches to the voice label, so the same voice is replaced everywhere (transcript,
     * minutes and exports) in one step.
     * @param props - bound `t`.
     */
    function SpeakerNamesDialog(props) {
      const t = props.t
      const s = useStore()
      const [drafts, setDrafts] = React.useState({})
      const [relabeling, setRelabeling] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      // The dialog mounts on open, so `autoFocus` on the wished-for row is enough; clear
      // the wish right away so reopening from the toolbar does not jump back to it.
      React.useEffect(() => { if (store.namesFocus !== '') set({ namesFocus: '' }) }, [])
      const close = () => { setDrafts({}); set({ namesOpen: false }) }
      const nameOf = (label) => drafts[label] ?? s.speakers[label] ?? ''
      const changed = s.labels.filter((label) => nameOf(label) !== (s.speakers[label] ?? ''))
      const saveAll = async () => {
        if (changed.length === 0) return
        setSaving(true)
        try {
          for (const label of changed) await nameSpeaker(label, nameOf(label).trim())
          set({ note: t('saved') })
          close()
        } finally {
          setSaving(false)
        }
      }
      return h('div', {
        style: { ...styles.overlay, zIndex: 4100 }, role: 'dialog', 'aria-modal': 'true',
        'aria-label': t('speakerNames'),
        onClick: close,
      }, h('div', {
        style: styles.namesDialog,
        onClick: (event) => event.stopPropagation(),
      }, [
        h('div', { key: 'head', style: styles.namesHead }, [
          h('span', { key: 'label', style: styles.label }, t('speakerNames')),
          s.labels.length === 0 ? null : h('span', { key: 'count', style: styles.stamp }, `${s.labels.length} ${t('speakerNamesCount')}`),
          h('span', { key: 'sp', style: styles.spacer }),
          h(Btn, {
            key: 'relabel', type: 'button', variant: 'ghost', disabled: relabeling,
            onClick: async () => {
              setRelabeling(true)
              await relabelRecording()
              setRelabeling(false)
            },
          }, relabeling ? t('speakerRelabeling') : t('speakerRelabel')),
          h('button', {
            key: 'close', type: 'button', style: styles.iconBtn,
            title: t('closeDialog'), 'aria-label': t('closeDialog'),
            onClick: close,
          }, h(Icon, { path: ICONS.close })),
        ]),
        s.labels.length === 0
          ? h('div', { key: 'empty', style: styles.namesBody },
            h('span', { key: 'text', style: styles.hint }, t('speakerNamesEmpty')))
          : h('div', { key: 'body', style: styles.namesBody }, [
            s.suggestions.length === 0 ? null : h('div', { key: 'sug', style: styles.list }, [
              h('span', { key: 'label', style: styles.hint }, t('voiceSuggestions')),
              ...s.suggestions.map((item) => h('div', { key: `${item.label}-${item.name}`, style: styles.row }, [
                h('span', { key: 'text', style: styles.status }, `${item.label} ${t('voiceSoundsLike')} ${item.name}（${item.score}）`),
                h(Btn, {
                  key: 'ok', type: 'button', variant: 'small',
                  onClick: () => { void nameSpeaker(item.label, item.name) },
                }, t('voiceAccept')),
              ])),
            ]),
            h('div', { key: 'rows', style: styles.list }, s.labels.map((label) => h('div', { key: label, style: styles.namesRow }, [
              h('span', { key: 'chip', style: styles.chip }, label),
              h(Field, {
                key: 'name', variant: 'wide',
                value: nameOf(label),
                placeholder: t('speakerNamePlaceholder'), spellCheck: false,
                list: OWNER_LIST_ID, autoFocus: label === s.namesFocus,
                onChange: (event) => setDrafts((value) => ({ ...value, [label]: event.target.value })),
                onKeyDown: (event) => { if (event.key === 'Enter') { void saveAll() } },
              }),
            ]))),
          ]),
        s.labels.length === 0 ? null : h('div', { key: 'foot', style: styles.namesFoot }, [
          h('span', { key: 'hint', style: styles.hint }, t('speakerNameHint')),
          h('span', { key: 'sp', style: styles.spacer }),
          h(Btn, { key: 'cancel', type: 'button', onClick: close }, t('cancelEntry')),
          h(Btn, {
            key: 'save', type: 'button', variant: 'primary', disabled: saving || changed.length === 0,
            onClick: () => { void saveAll() },
          }, t('saveEntry')),
        ]),
        h('datalist', { key: 'owners', id: OWNER_LIST_ID },
          ownerSuggestions(s.speakers).map((name) => h('option', { key: name, value: name }))),
      ]))
    }

    /**
     * The merged points & assignments tab: one list, points first (with their kind),
     * then the assignments (owner, due, priority, done). Add rows sit under each part.
     * @param props - bound `t`.
     */
    function NotesTab(props) {
      const t = typeof props.t === 'function' ? props.t : tx
      const s = useStore()
      const readOnly = s.viewed !== null
      const [newPoint, setNewPoint] = React.useState({ text: '', kind: 'point' })
      const [newTask, setNewTask] = React.useState('')
      const [editing, setEditing] = React.useState('')
      const [draft, setDraft] = React.useState({ text: '', kind: 'point' })
      const [customDueIds, setCustomDueIds] = React.useState([])

      const addPoint = async () => {
        const text = newPoint.text.trim()
        if (text === '') return
        const id = await ensureMeeting()
        if (id === '') return
        try {
          const reply = await post('/analysis', { meetingId: id, kind: 'point', op: 'add', text, pointKind: newPoint.kind, origin: 'manual' })
          if (Array.isArray(reply.points)) store.points = reply.points
          if (Array.isArray(reply.tasks)) store.tasks = reply.tasks
          setNewPoint({ text: '', kind: newPoint.kind })
          store.note = t('entryAdded')
          store.emit()
        } catch (failure) {
          set({ error: failure instanceof Error ? failure.message : String(failure) })
        }
      }

      const addTask = async () => {
        const text = newTask.trim()
        if (text === '') return
        const id = await ensureMeeting()
        if (id === '') return
        try {
          const reply = await post('/analysis', { meetingId: id, kind: 'task', op: 'add', text, origin: 'manual' })
          if (Array.isArray(reply.points)) store.points = reply.points
          if (Array.isArray(reply.tasks)) store.tasks = reply.tasks
          setNewTask('')
          store.note = t('entryAdded')
          store.emit()
        } catch (failure) {
          set({ error: failure instanceof Error ? failure.message : String(failure) })
        }
      }

      const owners = ownerSuggestions(s.speakers)

      return h('div', { style: styles.list }, [
        h('div', { key: 'head', style: styles.row }, [
          h('span', { key: 'label', style: styles.label }, `${t('tabNotes')} · ${t('points')} ${s.points.length} / ${t('tasks')} ${s.tasks.length}`),
          readOnly ? null : h(Btn, {
            key: 'extract', type: 'button', variant: 'ghost',
            disabled: s.segments.length === 0,
            onClick: () => { void extractNow() },
          }, t('extractNow')),
        ]),
        s.points.length === 0 && s.tasks.length === 0
          ? h('p', { key: 'hint', style: styles.empty }, t('notesNoRecording'))
          : null,
        // Points
        ...s.points.map((point) => editing === point.id
          ? h('div', { key: point.id, style: styles.entryRow }, [
            h(Field, {
              key: 'text', variant: 'wide', value: draft.text, placeholder: t('pointTextPh'), spellCheck: false,
              onChange: (event) => setDraft((value) => ({ ...value, text: event.target.value })),
              onKeyDown: (event) => { if (event.key === 'Enter') { void editEntry('point', point.id, draft); setEditing('') } },
            }),
            h(Picker, {
              key: 'kind', value: draft.kind,
              onChange: (event) => setDraft((value) => ({ ...value, kind: event.target.value })),
            }, POINT_KIND_VALUES.map((value) => h('option', { key: value, value }, t(`point_${value}`)))),
            h(Btn, {
              key: 'save', type: 'button', variant: 'small',
              onClick: () => { void editEntry('point', point.id, draft); setEditing('') },
            }, t('saveEntry')),
            h(Btn, { key: 'cancel', type: 'button', variant: 'small', onClick: () => setEditing('') }, t('cancelEntry')),
          ])
          : h('div', { key: point.id, style: point.status === 'confirmed' ? styles.entryRow : styles.entryRowDraft }, [
            h(Field, {
              key: 'done', type: 'checkbox', checked: point.status === 'confirmed', title: t('confirm'), disabled: readOnly,
              onChange: (event) => { void editEntry('point', point.id, { status: event.target.checked ? 'confirmed' : 'draft' }) },
            }),
            h('span', { key: 'kind', style: { ...styles.chip, color: 'var(--dsw-alias-brand-primary)' } }, t(`point_${point.kind}`)),
            h('span', { key: 'text', style: styles.entryText }, point.text),
            h('span', { key: 'origin', style: styles.chip }, point.origin === 'agent' ? t('originAgent') : point.origin === 'rule' ? t('originRule') : t('originManual')),
            readOnly ? null : h(Btn, {
              key: 'edit', type: 'button', variant: 'small',
              onClick: () => { setEditing(point.id); setDraft({ text: point.text, kind: POINT_KIND_VALUES.includes(point.kind) ? point.kind : 'point' }) },
            }, t('editEntry')),
            readOnly ? null : h(Btn, {
              key: 'del', type: 'button', variant: 'small',
              onClick: () => { void editEntry('point', point.id, {}, 'remove') },
            }, t('remove')),
          ])),
        // Tasks
        ...s.tasks.map((task) => {
          const taskOwners = [...owners]
          if (task.owner !== '' && !taskOwners.includes(task.owner)) taskOwners.push(task.owner)
          const presets = duePresets()
          const customDue = task.due !== '' && !presets.some((entry) => entry.value === task.due)
          const showDuePicker = customDueIds.includes(task.id) || customDue
          return h('div', { key: task.id, style: task.status === 'confirmed' ? styles.entryRow : styles.entryRowDraft }, [
            h(Field, {
              key: 'done', type: 'checkbox', checked: task.done === true, disabled: readOnly,
              title: task.done === true ? `${t('taskDoneAt')}${typeof task.doneAt === 'number' ? ` ${new Date(task.doneAt).toLocaleString()}` : ''}` : t('taskMarkDone'),
              onChange: (event) => { void editEntry('task', task.id, { done: event.target.checked }) },
            }),
            h(Field, {
              key: 'title', variant: 'wide',
              defaultValue: task.title, readOnly,
              placeholder: t('taskTitlePh'), spellCheck: false,
              title: task.status === 'draft' ? t('taskDraft') : t('taskConfirmed'),
              onBlur: (event) => {
                const next = event.target.value.trim()
                if (next !== '' && next !== task.title) void editEntry('task', task.id, { title: next })
                else event.target.value = task.title
              },
            }),
            h('span', { key: 'origin', style: styles.chip }, task.origin === 'agent' ? t('originAgent') : task.origin === 'rule' ? t('originRule') : t('originManual')),
            h(Picker, {
              key: 'owner', value: task.owner, title: t('ownerPh'), disabled: readOnly,
              onChange: (event) => { void editEntry('task', task.id, { owner: event.target.value }) },
            }, [
              h('option', { key: '', value: '' }, t('ownerPh')),
              ...taskOwners.map((name) => h('option', { key: name, value: name }, name)),
            ]),
            h(Picker, {
              key: 'due', value: showDuePicker ? CUSTOM_DUE : task.due, title: t('duePh'), disabled: readOnly,
              onChange: (event) => {
                const next = event.target.value
                if (next !== CUSTOM_DUE) {
                  setCustomDueIds((ids) => ids.filter((id) => id !== task.id))
                  void editEntry('task', task.id, { due: next })
                  return
                }
                setCustomDueIds((ids) => (ids.includes(task.id) ? ids : [...ids, task.id]))
                void editEntry('task', task.id, { due: dueDraftOf(task.due).replace('T', ' ') })
              },
            }, [
              ...presets.map((entry) => h('option', { key: entry.key, value: entry.value }, t(entry.key))),
              h('option', { key: 'custom', value: CUSTOM_DUE }, t('dueCustom')),
            ]),
            showDuePicker ? h(Field, {
              key: 'duepick', type: 'datetime-local', variant: 'tight',
              value: dueDraftOf(task.due), spellCheck: false,
              onChange: (event) => { void editEntry('task', task.id, { due: event.target.value.replace('T', ' ') }) },
            }) : null,
            h(Picker, {
              key: 'priority', value: TASK_PRIORITY_VALUES.includes(task.priority) ? task.priority : 'normal', title: t('priority'), disabled: readOnly,
              onChange: (event) => { void editEntry('task', task.id, { priority: event.target.value }) },
            }, TASK_PRIORITY_VALUES.map((value) => h('option', { key: value, value }, t(PRIORITY_KEYS[value])))),
            readOnly ? null : h(Btn, {
              key: 'del', type: 'button', variant: 'small',
              onClick: () => { void editEntry('task', task.id, {}, 'remove') },
            }, t('remove')),
          ])
        }),
        readOnly ? null : h('div', { key: 'addpoint', style: styles.row }, [
          h(Field, {
            key: 'text', variant: 'wide', value: newPoint.text, placeholder: t('pointTextPh'), spellCheck: false,
            onChange: (event) => setNewPoint((value) => ({ ...value, text: event.target.value })),
            onKeyDown: (event) => { if (event.key === 'Enter') void addPoint() },
          }),
          h(Picker, {
            key: 'kind', value: newPoint.kind,
            onChange: (event) => setNewPoint((value) => ({ ...value, kind: event.target.value })),
          }, POINT_KIND_VALUES.map((value) => h('option', { key: value, value }, t(`point_${value}`)))),
          h(Btn, { key: 'add', type: 'button', variant: 'small', onClick: () => { void addPoint() } }, `${t('addEntry')}·${t('points')}`),
        ]),
        readOnly ? null : h('div', { key: 'addtask', style: styles.row }, [
          h(Field, {
            key: 'text', variant: 'wide', value: newTask, placeholder: t('taskTitlePh'), spellCheck: false,
            onChange: (event) => setNewTask(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') void addTask() },
          }),
          h(Btn, { key: 'add', type: 'button', variant: 'small', onClick: () => { void addTask() } }, `${t('addEntry')}·${t('tasks')}`),
        ]),
      ])
    }

    /**
     * The minutes tab: generate/export buttons, the stored documents, and the inline
     * viewer for one of them.
     * @param props - bound `t`.
     */
    function MinutesTab(props) {
      const t = typeof props.t === 'function' ? props.t : tx
      const s = useStore()
      const [openDoc, setOpenDoc] = React.useState(null)
      const openStored = async (entry) => {
        try {
          const reply = await get(`/file?name=${encodeURIComponent(entry.name)}`)
          setOpenDoc(typeof reply.content === 'string' ? reply.content : '')
        } catch (failure) {
          set({ error: failure instanceof Error ? failure.message : String(failure) })
        }
      }
      return h('div', { style: styles.list }, [
        h('div', { key: 'head', style: styles.row }, [
          h(Btn, { key: 'md', type: 'button', variant: 'primary', onClick: () => { void writeMinutes('md') } }, t('minutes')),
          h(Btn, { key: 'docx', type: 'button', variant: 'ghost', onClick: () => { void writeMinutes('docx') } }, t('minutesDocx')),
        ]),
        s.documents.length === 0
          ? h('p', { key: 'empty', style: styles.empty }, t('minutesTabEmpty'))
          : h('div', { key: 'docs', style: styles.list }, [
            h('span', { key: 'label', style: styles.label }, `${t('documentsTitle')} (${s.documents.length})`),
            ...s.documents.map((entry) => h('div', { key: entry.id, style: styles.row }, [
              h('span', { key: 'title', style: { flex: 1, fontSize: 13 } }, entry.title),
              h('span', { key: 'name', style: styles.chip }, entry.name),
              h(Btn, { key: 'open', type: 'button', variant: 'small', onClick: () => { void openStored(entry) } }, t('openDocument')),
            ])),
          ]),
        openDoc === null ? null : h('div', { key: 'view', style: styles.list }, [
          h('div', { key: 'bar', style: styles.row }, [
            h('span', { key: 'sp', style: styles.spacer }),
            h(Btn, { key: 'close', type: 'button', variant: 'small', onClick: () => setOpenDoc(null) }, t('closeDocument')),
          ]),
          h('div', { key: 'doc', style: styles.docView }, openDoc),
        ]),
      ])
    }

    /**
     * The history list: search, scroll-paged rows, click to open a past meeting
     * read-only in this dialog.
     * @param props - bound `t`.
     */
    function HistoryTab(props) {
      const t = typeof props.t === 'function' ? props.t : tx
      const s = useStore()
      const composingRef = React.useRef(false)
      const searchTimer = React.useRef(0)
      const listRef = React.useRef(null)
      React.useEffect(() => {
        void loadHistory('')
        return () => window.clearTimeout(searchTimer.current)
      }, [])
      const onScroll = (event) => {
        const box = event.currentTarget
        if (box.scrollTop + box.clientHeight < box.scrollHeight - 24) return
        if (store.history.loading === true || store.history.loadingMore === true) return
        if (store.history.rows.length >= store.history.total) return
        void loadHistory(store.history.query, true)
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, flex: '1 1 auto' } }, [
        h(Field, {
          key: 'query', variant: 'wide', type: 'text', role: 'searchbox',
          value: s.history.query, placeholder: t('historyPlaceholder'), spellCheck: false,
          // The history tab is a COLUMN flexbox: without this, the wide variant's
          // `flex: 1 1 120px` stretches the input's HEIGHT to fill the whole area.
          style: { flex: '0 0 auto' },
          onChange: (event) => {
            const value = event.target.value
            set({ history: { ...store.history, query: value } })
            window.clearTimeout(searchTimer.current)
            if (composingRef.current) return
            searchTimer.current = window.setTimeout(() => { void loadHistory(value) }, 150)
          },
          onCompositionStart: () => { composingRef.current = true },
          onCompositionEnd: (event) => {
            composingRef.current = false
            window.clearTimeout(searchTimer.current)
            void loadHistory(event.target.value)
          },
        }),
        s.history.rows.length === 0
          ? h('p', { key: 'none', style: styles.empty }, s.history.loading === true ? t('historyLoading') : t('historyEmpty'))
          : h('div', {
            key: 'list', ref: listRef, onScroll,
            style: { ...styles.transcriptBox, gap: '4px' },
          }, [
            ...s.history.rows.map((row) => h('div', {
              key: row.meetingId, style: { ...styles.historyRow, border: '1px solid var(--dsw-alias-border-l1)' },
              className: 'mn-hover', role: 'button', tabIndex: 0,
              title: t('historyChoose'),
              onClick: () => { void openHistorical(row) },
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void openHistorical(row)
                }
              },
            }, [
              h('div', { key: 'head', style: styles.historyHead }, [
                h('span', { key: 'when', style: styles.stamp }, new Date(row.startedAt).toLocaleString()),
                h('span', { key: 'name', style: styles.historyName }, row.title === '' ? t('unnamed') : row.title),
                row.hasContent === true ? null : h('span', { key: 'blank', style: styles.chip }, t('historyBlank')),
                // The one destructive action on the row: right-aligned, its own button so
                // neither the click nor the keys reach the row's open-the-meeting handler.
                h('span', { key: 'sp', style: styles.spacer }),
                h('button', {
                  key: 'del', type: 'button', className: 'mn-del',
                  title: t('historyDeleteHint'),
                  'aria-label': `${t('historyDelete')}：${row.title === '' ? t('unnamed') : row.title}`,
                  onClick: (event) => {
                    event.stopPropagation()
                    void deleteHistorical(row, t)
                  },
                  // Enter/Space on the delete button must not bubble into the row's
                  // open handler, which would both delete AND open the meeting.
                  onKeyDown: (event) => event.stopPropagation(),
                }, h(Icon, { path: ICONS.trash, size: 13 })),
              ]),
              h('span', { key: 'meta', style: styles.stamp },
                `${t('tabTranscript')} ${row.counts.segments} · ${t('points')} ${row.counts.points} · ${t('tasks')} ${row.counts.tasks}`),
              row.excerpt === '' ? null : h('span', { key: 'ex', style: styles.historyExcerpt }, row.excerpt.length > 100 ? `${row.excerpt.slice(0, 100)}…` : row.excerpt),
            ])),
            h('div', { key: 'more', style: { ...styles.hint, textAlign: 'center', padding: '6px' } },
              s.history.rows.length >= s.history.total ? t('historyAll') : (s.history.loadingMore === true ? t('historyLoading') : t('historyMore'))),
          ]),
      ])
    }

    /** Local model kinds, in the order the settings page lists them. */
    const MODEL_KIND_ORDER = [
      ['asr', 'modelKindAsr'],
      ['speaker', 'modelKindSpeaker'],
    ]

    /**
     * One local-model row: what it is, whether it is usable, and the one action that
     * applies to that state.
     * @param props - catalog entry, state flags and callbacks.
     */
    function ModelRow(props) {
      const { model, t } = props
      const state = model.locked === true
        ? t('modelByDsh')
        : model.verified === true ? t('modelStateReady') : model.installed === true ? t('modelStateBad') : t('modelStateMissing')
      const size = model.totalBytes === 0 ? '—' : `${(model.totalBytes / 1048576).toFixed(1)} MB`
      const actions = []
      if (model.locked !== true) {
        if (model.verified === true) {
          actions.push(h(Btn, {
            key: 'activate', type: 'button', variant: 'small',
            disabled: props.used || props.busy,
            onClick: () => props.onActivate(model.id, model.kind),
          }, props.used ? t('modelInUse') : t('modelActivate')))
        } else {
          actions.push(h(Btn, {
            key: 'install', type: 'button', variant: 'small',
            disabled: props.busy || props.downloading,
            onClick: () => props.onInstall(model.id),
          }, props.retry ? t('modelRetry') : t('modelInstall')))
        }
        actions.push(h(Btn, {
          key: 'import', type: 'button', variant: 'small',
          disabled: props.busy, title: t('modelImportHint'),
          onClick: () => props.onImport(model),
        }, t('modelImportFile')))
        if (model.builtin !== true) {
          actions.push(h(Btn, {
            key: 'remove', type: 'button', variant: 'small',
            disabled: props.busy,
            onClick: () => props.onRemove(model.id),
          }, t('modelRemove')))
        }
      }
      return h('div', { style: styles.list }, [
        h('div', { key: 'row', style: styles.row }, [
          h('span', { key: 'name', style: styles.label }, `${model.name}${props.used ? ` · ${t('modelInUse')}` : ''}`),
          h('span', { key: 'state', style: styles.stamp }, state),
        ]),
        h('span', { key: 'meta', style: styles.hint }, `${size}${model.languages.length === 0 ? '' : ` · ${model.languages.join('/')}`}`),
        model.note === '' ? null : h('span', { key: 'note', style: styles.hint }, model.note),
        model.licence === '' ? null : h('span', { key: 'licence', style: styles.hint }, `${t('modelLicence')}：${model.licence}`),
        h('div', { key: 'actions', style: styles.row }, actions),
      ])
    }

    /**
     * The folder chooser behind 选择文件夹…: real directories listed by the host half,
     * started from the current setting (which falls back to its nearest existing
     * ancestor, so a not-yet-created workspace folder still opens somewhere useful).
     * Navigation enters subfolders; 新建 makes one new subfolder in place; the confirm
     * button writes the browsed folder back into the read-only path field.
     * @param props - `startPath` to open at, `onCancel`, and `onChoose(path)`.
     */
    function FolderPicker(props) {
      const [current, setCurrent] = React.useState('')
      const [parent, setParent] = React.useState('')
      const [folders, setFolders] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [name, setName] = React.useState('')
      const [problem, setProblem] = React.useState('')
      const load = React.useCallback(async (target) => {
        setBusy(true); setProblem('')
        try {
          const reply = await get(`/workspace-folders?path=${encodeURIComponent(target)}`)
          setCurrent(typeof reply.path === 'string' ? reply.path : '')
          setParent(typeof reply.parent === 'string' ? reply.parent : '')
          setFolders(Array.isArray(reply.folders) ? reply.folders : [])
        } catch (error) { setProblem(error.message) }
        finally { setBusy(false) }
      }, [])
      React.useEffect(() => { void load(typeof props.startPath === 'string' ? props.startPath : '') }, [load, props.startPath])
      const create = async () => {
        const trimmed = name.trim()
        if (trimmed === '') return
        setBusy(true); setProblem('')
        try { const reply = await post('/workspace-folder', { parent: current, name: trimmed }); setName(''); await load(reply.path) }
        catch (error) { setProblem(error.message); setBusy(false) }
      }
      return h('div', {
        style: styles.overlay, role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择文件夹',
        onClick: (event) => { if (event.target === event.currentTarget) props.onCancel() },
      }, [
        h('div', { key: 'dialog', style: styles.pickDialog }, [
          h('div', { key: 'head', style: styles.dialogHead }, [
            h('strong', { key: 'title' }, '选择文件夹'),
            h('span', { key: 'path', style: styles.pickPath, title: current }, current),
          ]),
          h('div', { key: 'list', style: styles.pickList }, [
            parent === '' ? null : h('div', {
              key: 'parent', className: 'mn-hover', style: styles.pickRow, title: parent,
              onClick: () => { void load(parent) },
            }, '↑ 上一级'),
            busy ? h('div', { key: 'busy', style: { ...styles.pickRow, cursor: 'default' } }, '正在读取…') : null,
            ...folders.map((folder) => h('div', {
              key: folder, className: 'mn-hover', style: styles.pickRow, title: folder,
              onClick: () => { void load(`${current}${current.endsWith('/') ? '' : '/'}${folder}`) },
            }, `📁 ${folder}`)),
            busy || folders.length > 0 ? null : h('div', { key: 'none', style: { ...styles.pickRow, cursor: 'default', color: 'var(--dsw-alias-label-secondary)' } }, '此文件夹内没有子文件夹'),
          ]),
          h('div', { key: 'new', style: styles.pickNew }, [
            h(Field, {
              key: 'name', value: name, placeholder: '新文件夹名称', maxLength: 80, spellCheck: false,
              onChange: (event) => setName(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') { void create() } },
            }),
            h(Btn, { key: 'add', type: 'button', disabled: busy || name.trim() === '', onClick: () => { void create() } }, '新建'),
          ]),
          problem === '' ? null : h('p', { key: 'problem', role: 'alert', style: { ...styles.hint, margin: '6px 12px 0' } }, problem),
          h('div', { key: 'foot', style: styles.pickFoot }, [
            h(Btn, { key: 'cancel', type: 'button', onClick: props.onCancel }, '取消'),
            h(Btn, { key: 'choose', type: 'button', variant: 'primary', disabled: busy || current === '', onClick: () => { props.onChoose(current) } }, '选择此文件夹'),
          ]),
        ]),
      ])
    }

    /**
     * The 会后工作区 card: where finished meetings land. The summary model that
     * used to live here moved into the models card below, next to the local
     * recognition models (SummaryModelSettings).
     * @param props - bound `t`, supplied by the registration's inject.
     */
    function WorkspaceSettings() {
      const [draft, update] = React.useState(null)
      const [message, notify] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      React.useEffect(() => {
        let live = true
        get('/workspace-settings').then((reply) => { if (live) update(reply.workspace) }, (error) => { if (live) notify(error.message) })
        return () => { live = false }
      }, [])
      const save = async () => {
        setBusy(true); notify('')
        try { const reply = await post('/workspace-settings', draft); update(reply.workspace); notify('已保存，下次结束会议时生效') }
        catch (error) { notify(error.message) }
        finally { setBusy(false) }
      }
      return h('div', { className: 'mn-card' }, [
        h('strong', { key: 'title' }, '会后工作区'),
        h('p', { key: 'hint', style: styles.hint }, '结束会议后自动在此工作区创建会话并整理纪要。文件夹路径通过「选择文件夹」浏览确定，不能直接输入；文件夹或工作区不存在时自动创建，已有相同文件夹的工作区会直接复用，不改名。'),
        draft ? h('label', { key: 'name', style: styles.list }, ['工作区名称', h(Field, { key: 'field', variant: 'line', value: draft.workspaceName, maxLength: 100, onChange: (event) => update({ ...draft, workspaceName: event.target.value }) })]) : null,
        draft ? h('label', { key: 'path', style: styles.list }, ['文件夹路径', h('div', { key: 'pick', style: styles.row }, [
          h(Field, { key: 'field', variant: 'wide', value: draft.folderPath, readOnly: true, title: '点击右侧按钮选择文件夹' }),
          h(Btn, { key: 'browse', type: 'button', onClick: () => { setPicking(true) } }, '选择文件夹…'),
        ])]) : null,
        h(Btn, { key: 'save', disabled: !draft || busy, variant: 'primary', onClick: () => { void save() } }, busy ? '正在保存…' : '保存工作区设置'),
        message ? h('p', { key: 'message', role: 'status', style: styles.hint }, message) : null,
        picking && draft ? h(FolderPicker, {
          key: 'picker', startPath: draft.folderPath,
          onCancel: () => { setPicking(false) },
          onChoose: (path) => { setPicking(false); update({ ...draft, folderPath: path }) },
        }) : null,
      ])
    }

    /**
     * The summary-model configuration inside the models card: the model the
     * background summary calls, picked from the DSH model catalog the host half
     * reads live — the same list DSH's own model picker offers. There is no
     * separate channel picker: options are grouped under each provider's name
     * and choosing a model adopts that provider automatically. Left on
     * 「DSH 默认」 it follows the host's current default selection. Saving
     * re-reads the stored workspace settings first, so an unsaved edit in the
     * workspace card above is never clobbered by this save.
     * @param props - bound `t`, supplied by the registration's inject.
     */
    function SummaryModelSettings(props) {
      const t = typeof props.t === 'function' ? props.t : tx
      const [catalog, setCatalog] = React.useState({ groups: [], default: null })
      const [draft, update] = React.useState(null)
      const [message, notify] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      React.useEffect(() => {
        let live = true
        Promise.all([get('/workspace-settings'), get('/summary-models')]).then(([workspace, summary]) => {
          if (!live) return
          update(workspace.workspace)
          setCatalog({ groups: Array.isArray(summary.groups) ? summary.groups : [], default: summary.default ?? null })
        }, (error) => { if (live) notify(error.message) })
        return () => { live = false }
      }, [])
      const groupOf = (modelId) => catalog.groups.find((group) => group.models.some((model) => model.id === modelId))
      const save = async () => {
        setBusy(true); notify('')
        try {
          // Re-read before writing: the workspace card owns the other fields and may
          // have saved since this block loaded its own copy.
          const current = await get('/workspace-settings')
          const reply = await post('/workspace-settings', {
            ...current.workspace,
            summaryProvider: draft.summaryProvider || '',
            summaryModel: draft.summaryModel || '',
          })
          update(reply.workspace)
          notify(t('summaryModelSaved'))
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }
      const modelOptions = catalog.groups.flatMap((group) => group.models)
      const staleModel = draft !== null && draft.summaryModel !== '' && !modelOptions.some((model) => model.id === draft.summaryModel)
      return h('div', { key: 'summary-block', style: styles.list }, [
        h('span', { key: 'summary-title', style: styles.label }, t('summaryModelTitle')),
        h('span', { key: 'summary-hint', style: styles.hint }, t('summaryModelHint')),
        catalog.groups.length === 0 ? h('span', { key: 'summary-empty', style: styles.hint }, t('summaryModelEmpty')) : null,
        draft ? h('label', { key: 'summary-model', style: styles.list }, [t('summaryModelModel'), h(Picker, {
          key: 'pick', value: draft.summaryModel || '', disabled: busy, 'aria-label': t('summaryModelModel'),
          onChange: (event) => {
            const model = event.target.value
            if (model === '') { update({ ...draft, summaryProvider: '', summaryModel: '' }); return }
            const owner = groupOf(model)
            update({ ...draft, summaryProvider: owner === undefined ? draft.summaryProvider : owner.id, summaryModel: model })
          },
        }, [
          h('option', { key: 'none', value: '' }, t('summaryModelDefault')),
          ...(staleModel ? [h('option', { key: 'stale', value: draft.summaryModel }, `${draft.summaryModel}${t('summaryModelStale')}`)] : []),
          ...catalog.groups.map((group) => h('optgroup', { key: group.id, label: group.name }, group.models.map((model) => h('option', { key: model.id, value: model.id }, model.name)))),
        ])]) : null,
        h('span', { key: 'summary-current', style: styles.hint }, `${t('summaryModelCurrentDefault')}：${catalog.default ? `${catalog.default.provider} / ${catalog.default.model}` : t('summaryModelUnsetDefault')}`),
        h('span', { key: 'summary-privacy', style: styles.hint }, t('summaryModelPrivacy')),
        h('div', { key: 'summary-actions', style: styles.row }, [
          h(Btn, { key: 'save', disabled: !draft || busy, variant: 'primary', onClick: () => { void save() } }, busy ? t('summaryModelSaving') : t('summaryModelSave')),
          message === '' ? null : h('span', { key: 'note', style: styles.status }, message),
        ]),
      ])
    }

    /**
     * The plugin's page inside DSH's settings (设置 → 会议记录): the models card
     * (local recognition models plus the background summary model), speaker
     * recognition, transcript cue shaping, and the terminology list — the
     * configuration the record flow keeps. The record dialog itself stopped
     * carrying a gear in the same move; this page is those settings' only home.
     * @param props - bound `t`, supplied by the registration's inject.
     */
    function MeetingSettingsSection(props) {
      const t = typeof props.t === 'function' ? props.t : tx
      const [problem, setProblem] = React.useState('')
      const [models, setModels] = React.useState({ models: [], active: {}, problem: '', directory: '', install: null })
      const [modelBusy, setModelBusy] = React.useState('')
      const [speakerSettings, setSpeakerSettings] = React.useState({ threshold: 0.6, fullRelabel: true, backfillCap: 60, presets: [] })
      const [speakerDraft, setSpeakerDraft] = React.useState({ threshold: 0.6, fullRelabel: true, backfillCap: 60 })
      const [voiceNote, setVoiceNote] = React.useState('')
      const [transcriptSettings, setTranscriptSettings] = React.useState({})
      const [transcriptDraft, setTranscriptDraft] = React.useState(null)
      const [transcriptNote, setTranscriptNote] = React.useState('')
      const [vocabulary, setVocabulary] = React.useState({ groups: [], total: 0, version: '' })
      const modelTarget = React.useRef({ id: '', name: '' })
      const modelField = React.useRef(null)

      /** Surface a failed request inline: the record dialog's error line is not this page's. */
      const fail = React.useCallback((failure) => {
        setProblem(failure instanceof Error ? failure.message : String(failure))
      }, [])

      const loadModels = React.useCallback(async () => {
        try {
          const value = await get('/models')
          setModels({
            models: Array.isArray(value.models) ? value.models : [],
            active: value.active ?? {},
            problem: typeof value.problem === 'string' ? value.problem : '',
            directory: typeof value.directory === 'string' ? value.directory : '',
            install: value.install ?? null,
          })
        } catch (failure) {
          fail(failure)
        }
      }, [fail])

      const loadSpeakerSettings = React.useCallback(async () => {
        try {
          const value = await get('/speaker/settings')
          const speaker = value.speaker ?? {}
          setSpeakerSettings({
            threshold: speaker.threshold ?? 0.6,
            fullRelabel: speaker.fullRelabel !== false,
            backfillCap: speaker.backfillCap ?? 60,
            presets: Array.isArray(value.presets) ? value.presets : [],
          })
          setSpeakerDraft({
            threshold: speaker.threshold ?? 0.6,
            fullRelabel: speaker.fullRelabel !== false,
            backfillCap: speaker.backfillCap ?? 60,
          })
        } catch (failure) {
          fail(failure)
        }
      }, [fail])

      const loadTranscript = React.useCallback(async () => {
        try {
          const value = await get('/transcript')
          const stored = value.transcript ?? {}
          setVocabulary(value.vocabulary && Array.isArray(value.vocabulary.groups) ? value.vocabulary : { groups: [], total: 0, version: '' })
          setTranscriptSettings(stored)
          setTranscriptDraft(stored)
        } catch (failure) {
          fail(failure)
        }
      }, [fail])

      // One page, so everything loads together: each card is cheap to read, and the
      // terminology area reads the shared store the record dialog keeps current.
      React.useEffect(() => {
        void loadModels()
        void loadSpeakerSettings()
        void loadTranscript()
      }, [loadModels, loadSpeakerSettings, loadTranscript])

      React.useEffect(() => {
        if (models.install?.phase !== 'downloading') return undefined
        const timer = setInterval(() => { void loadModels() }, 1000)
        return () => clearInterval(timer)
      }, [models.install?.phase, loadModels])

      const installModelNow = async (id) => {
        setModelBusy(id)
        try {
          const reply = await post('/models/install', { id })
          if (reply.error !== undefined) setProblem(String(reply.error))
        } catch (failure) {
          fail(failure)
        } finally {
          setModelBusy('')
          await loadModels()
        }
      }

      const importModelNow = async (id, name, file) => {
        if (file === undefined || file === null) return
        setModelBusy(id)
        try {
          const response = await fetch(`${PREFIX}/models/import?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
          })
          const text = await response.text()
          let value = {}
          try { value = text === '' ? {} : JSON.parse(text) } catch { value = {} }
          if (!response.ok) setProblem(typeof value.error === 'string' ? value.error : `${response.status}`)
        } catch (failure) {
          fail(failure)
        } finally {
          setModelBusy('')
          await loadModels()
        }
      }

      const activateModelNow = async (kind, id) => {
        setModelBusy(id)
        try {
          const reply = await post('/models/activate', { kind, id })
          if (reply.error !== undefined) setProblem(String(reply.error))
        } catch (failure) {
          fail(failure)
        } finally {
          setModelBusy('')
          await loadModels()
        }
      }

      const removeModelNow = async (id) => {
        setModelBusy(id)
        try {
          const reply = await post('/models/remove', { id })
          if (reply.error !== undefined) setProblem(String(reply.error))
        } catch (failure) {
          fail(failure)
        } finally {
          setModelBusy('')
          await loadModels()
        }
      }

      const saveSpeaker = async () => {
        setVoiceNote('')
        try {
          const reply = await post('/speaker/settings', speakerDraft)
          setVoiceNote(reply.restarted === true ? t('speakerRestarted') : t('saved'))
          await loadSpeakerSettings()
        } catch (failure) {
          fail(failure)
        }
      }

      const saveTranscript = async () => {
        setTranscriptNote('')
        try {
          const reply = await post('/transcript', transcriptDraft ?? {})
          setTranscriptSettings(reply.transcript)
          setTranscriptDraft(reply.transcript)
          setTranscriptNote(t('saved'))
        } catch (failure) {
          fail(failure)
        }
      }

      const renderModelRow = (model) => h(ModelRow, {
        key: model.id, model, t,
        used: models.active[model.kind] === model.id,
        busy: modelBusy === model.id,
        downloading: models.install?.phase === 'downloading',
        retry: models.install?.phase === 'failed' && models.install.id === model.id,
        onActivate: (id, kind) => { void activateModelNow(kind, id) },
        onInstall: (id) => { void installModelNow(id) },
        onImport: (entry) => {
          modelTarget.current = { id: entry.id, name: entry.files[0]?.name ?? '' }
          modelField.current?.click()
        },
        onRemove: (id) => { void removeModelNow(id) },
      })
      const otherModels = models.models.filter((model) => !MODEL_KIND_ORDER.some(([kind]) => kind === model.kind))

      return h('div', { key: 'meeting-settings', style: styles.settingsSection }, [
        h('h2', { key: 'head', style: styles.settingsHeading }, t('settingsNav')),
        h('p', { key: 'intro', style: styles.settingsIntro }, t('settingsIntro')),
        problem === '' ? null : h('p', { key: 'problem', style: styles.error, role: 'alert' }, `${t('error')}: ${problem}`),
        h(WorkspaceSettings, { key: 'workspace' }),
        // Models: the local catalog. Recognition stays on this machine — the cloud
        // route this card used to carry was removed on purpose.
        h('div', { key: 'models', className: 'mn-card' }, [
            h('span', { key: 'mh', style: styles.label }, t('settingsModels')),
            h('span', { key: 'hint', style: styles.hint }, t('modelsHint')),
            models.problem === '' ? null : h('p', { key: 'problem', style: styles.error }, models.problem),
            models.install?.phase === 'downloading'
              ? h('p', { key: 'progress', style: styles.note }, `${t('modelDownloading')} ${models.install.file} · ${models.install.total > 0 ? Math.min(100, Math.floor(models.install.received * 100 / models.install.total)) : 0}%`)
              : null,
            h('span', { key: 'lh', style: styles.label }, t('modelsLocalTitle')),
            h('div', { key: 'list', style: styles.list }, [
              ...MODEL_KIND_ORDER.flatMap(([kind, labelKey]) => {
                const rows = models.models.filter((model) => model.kind === kind)
                if (rows.length === 0) return []
                return [
                  h('span', { key: `k-${kind}`, style: styles.stamp }, t(labelKey)),
                  ...rows.map(renderModelRow),
                ]
              }),
              ...(otherModels.length === 0 ? [] : [
                h('span', { key: 'k-other', style: styles.stamp }, t('modelKindOther')),
                ...otherModels.map(renderModelRow),
              ]),
            ]),
            h('span', { key: 'dir', style: styles.hint }, `${t('modelDirectory')}：${models.directory}`),
            // The background summary's model: one more model configuration in this
            // card, picked from the DSH model catalog instead of the local files.
            h(SummaryModelSettings, { key: 'summary', t }),
            h('input', {
              key: 'file', type: 'file', ref: modelField, style: { display: 'none' },
              onChange: (event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                const target = modelTarget.current
                void importModelNow(target.id, target.name, file)
              },
            }),
        ]),
        // Speaker recognition: always on while recording; what is configured here is the
        // clustering threshold and the end-of-meeting pass. The voice library itself keeps
        // learning (a named voice is suggested next time) but is no longer listed here.
        h('div', { key: 'speaker', className: 'mn-card' }, [
            h('span', { key: 'th', style: styles.label }, t('settingsSpeaker')),
            h('div', { key: 'presets', style: styles.row }, [
              h('span', { key: 'label', style: styles.status }, t('speakerThreshold')),
              ...speakerSettings.presets.map((preset) => h(Btn, {
                key: preset.id, type: 'button',
                variant: speakerDraft.threshold === preset.threshold ? 'active' : 'ghost',
                title: preset.note,
                onClick: () => setSpeakerDraft((draft) => ({ ...draft, threshold: preset.threshold })),
              }, `${preset.threshold}`)),
              h(Field, {
                key: 'value', type: 'number', variant: 'tight', value: String(speakerDraft.threshold),
                onChange: (event) => setSpeakerDraft((draft) => ({ ...draft, threshold: Number(event.target.value) })),
              }),
            ]),
            h('div', { key: 'full', style: styles.row }, [
              h(Field, {
                key: 'cb', type: 'checkbox', checked: speakerDraft.fullRelabel,
                onChange: (event) => setSpeakerDraft((draft) => ({ ...draft, fullRelabel: event.target.checked })),
              }),
              h('span', { key: 'label', style: styles.status }, t('speakerFullRelabel')),
              speakerDraft.fullRelabel ? null : h(Field, {
                key: 'cap', type: 'number', variant: 'tight', value: String(speakerDraft.backfillCap),
                onChange: (event) => setSpeakerDraft((draft) => ({ ...draft, backfillCap: Number(event.target.value) })),
              }),
            ]),
            h('span', { key: 'hint', style: styles.hint }, t('speakerSettingsHint')),
            h('div', { key: 'actions', style: styles.row }, [
              h(Btn, { key: 'save', type: 'button', onClick: () => { void saveSpeaker() } }, t('speakerSave')),
              voiceNote === '' ? null : h('span', { key: 'note', style: styles.status }, voiceNote),
            ]),
          ]),
        // Transcript reading rules only. Auto-correction is unconditional and has no
        // row here at all (the model card already discloses what it sends); segmentation
        // is fully automatic — the endpointer adapts to the room, one speaker's talk
        // packs into ~200-character paragraphs and a new voice breaks at once.
        h('div', { key: 'transcript', className: 'mn-card' }, [
            h('span', { key: 'th', style: styles.label }, t('transcriptTitle')),
            h('div', { key: 'norm', style: styles.row }, [
              h(Field, {
                key: 'cb', type: 'checkbox',
                checked: transcriptDraft?.normalize !== false,
                onChange: (event) => setTranscriptDraft((draft) => ({ ...(draft ?? transcriptSettings), normalize: event.target.checked })),
              }),
              h('span', { key: 'label', style: styles.status }, t('transcriptNormalize')),
            ]),
            h('span', { key: 'nhint', style: styles.hint }, t('transcriptNormalizeHint')),
            h('div', { key: 'smooth', style: styles.row }, [
              h(Field, {
                key: 'cb', type: 'checkbox',
                checked: transcriptDraft?.smooth === true,
                onChange: (event) => setTranscriptDraft((draft) => ({ ...(draft ?? transcriptSettings), smooth: event.target.checked })),
              }),
              h('span', { key: 'label', style: styles.status }, t('transcriptSmooth')),
            ]),
            h('span', { key: 'shint', style: styles.hint }, t('transcriptSmoothHint')),
            h('div', { key: 'actions', style: styles.row }, [
              h(Btn, { key: 'save', type: 'button', onClick: () => { void saveTranscript() } }, t('transcriptSave')),
              transcriptNote === '' ? null : h('span', { key: 'note', style: styles.status }, transcriptNote),
            ]),
          ]),
        // Installation-wide read-only reference packs; never mixed into store.termsText.
        h('div', { key: 'vocabulary', className: 'mn-card' }, [
          h('span', { key: 'title', style: styles.label }, `${t('vocabularyTitle')} · ${vocabulary.total} · ${vocabulary.version}`),
          h('span', { key: 'hint', style: styles.hint }, t('vocabularyHint')),
          h('label', { key: 'enable', style: styles.row }, [
            h(Field, { key: 'cb', type: 'checkbox', checked: transcriptDraft?.builtInVocabulary !== false,
              onChange: (event) => setTranscriptDraft((draft) => ({ ...(draft ?? transcriptSettings), builtInVocabulary: event.target.checked })),
            }),
            h('span', { key: 'text', style: styles.status }, t('vocabularyEnable')),
          ]),
          // The pack rows used to sit open — the growing catalog made this card
          // tower over the settings page. The rows now share ONE disclosure that
          // starts closed, and its summary keeps reporting the live selection
          // count while collapsed. Opened, the rows render inside vocabPanel —
          // a fixed-height panel that scrolls internally (each pack's word list
          // scrolls in its own bounded box), so the card never grows unboundedly.
          h('details', { key: 'packs' }, [
            h('summary', { key: 'summary', style: styles.hint }, vocabulary.groups.length === 0 ? t('vocabularyPacks')
              : `${t('vocabularyPacks')} · ${t('vocabularySelected')} ${vocabulary.groups.filter((group) => group.alwaysIncluded || (transcriptDraft?.vocabularyDomains ?? []).includes(group.id)).length}/${vocabulary.groups.length}`),
            h('div', { key: 'panel', style: styles.vocabPanel },
              vocabulary.groups.map((group) => h('div', { key: group.id }, [
                h('label', { key: 'pick', style: styles.row }, [
                  h(Field, { key: 'cb', type: 'checkbox',
                    checked: group.alwaysIncluded || (transcriptDraft?.vocabularyDomains ?? []).includes(group.id),
                    disabled: group.alwaysIncluded || transcriptDraft?.builtInVocabulary === false,
                    onChange: (event) => setTranscriptDraft((draft) => {
                      const next = draft ?? transcriptSettings
                      const domains = new Set(next.vocabularyDomains ?? [])
                      if (event.target.checked) domains.add(group.id)
                      else domains.delete(group.id)
                      return { ...next, vocabularyDomains: [...domains] }
                    }),
                  }),
                  h('span', { key: 'name', style: styles.status }, `${group.name} / ${group.nameEn} (${group.count})${group.alwaysIncluded ? ` · ${t('vocabularyCommon')}` : ''}`),
                ]),
                h('details', { key: 'entries' }, [
                  h('summary', { key: 'summary', style: styles.hint }, `${t('vocabularyBrowse')} · ${group.count}`),
                  h('p', { key: 'words', style: styles.vocabEntries }, (group.entries ?? []).map((entry) => `${entry.word}${entry.aliases?.length ? ` (${entry.aliases.join(' / ')})` : ''}`).join('、')),
                ]),
              ]))),
          ]),
          h('div', { key: 'save', style: styles.row }, [
            h(Btn, { key: 'button', type: 'button', onClick: () => { void saveTranscript() } }, t('vocabularySave')),
            transcriptNote === '' ? null : h('span', { key: 'note', style: styles.status }, transcriptNote),
          ]),
        ]),
        // Terminology: names, companies, projects and jargon the recognizer gets wrong.
        h('div', { key: 'terms', className: 'mn-card' }, [
            h('span', { key: 'th', style: styles.label }, t('settingsTerms')),
            h('span', { key: 'hint', style: styles.hint }, t('termsHint')),
            h(Field, {
              key: 'area', variant: 'area', value: store.termsText, spellCheck: false,
              onChange: (event) => { store.termsText = event.target.value; store.emit() },
              onBlur: () => syncTerms(),
            }),
        ]),
      ])
    }

    /**
     * The record dialog itself, registered in the frame-wide overlay layer: header
     * (status, editable title, history/close), tabs (transcript / merged points /
     * minutes), and a footer console with the recording controls. The configuration
     * this dialog used to carry behind a gear lives in DSH's settings now
     * (设置 → 会议记录, the MeetingSettingsSection this module registers).
     * @param props - bound `t`.
     */
    function MeetingOverlay(props) {
      const t = typeof props.t === 'function' ? props.t : tx
      const s = useStore()

      // Opening the dialog NEVER adopts the session's older meeting: openDialog already
      // reset the panel to a brand-new one when nothing is recording, and adopting here
      // would pull the just-finished record (transcript, clock, name) back into the empty
      // panel. Only the speech-model watch belongs at open.
      React.useEffect(() => {
        if (s.open !== true) return undefined
        if (s.speech.phase === 'checking') void watchSpeech()
      }, [s.open])

      // A long pause gets one reminder.
      React.useEffect(() => {
        if (!s.paused) return undefined
        const timer = setInterval(() => {
          if (store.pauseWarned) return
          if (Date.now() - store.pausedAt > 10 * 60 * 1000) {
            store.pauseWarned = true
            store.note = t('pauseLongHint')
            store.emit()
          }
        }, 30 * 1000)
        return () => clearInterval(timer)
      }, [s.paused, t])

      // The agent's start request (meeting_session record): the dialog opens from the
      // pending watcher; this poll performs the start through the same start().
      React.useEffect(() => {
        if (s.open !== true) return undefined
        if (s.viewed !== null) return undefined
        const timer = setInterval(() => {
          void (async () => {
            if (store.phase !== 'idle' || store.active !== null || store.sessionId === '') return
            try {
              const value = await get(`/record?sessionId=${encodeURIComponent(store.sessionId)}`)
              const request = typeof value.request === 'number' ? value.request : 0
              if (request <= 0) return
              await post('/record', { sessionId: store.sessionId })
              if (Date.now() - request > 120_000) return
              store.autoStart = true
              await start()
            } catch {
              // No meeting yet, or the host is restarting: the next tick tries again.
            }
          })()
        }, 3000)
        return () => clearInterval(timer)
      }, [s.open, s.viewed])

      // Escape closes the speaker-names dialog first, then the history list, then the
      // dialog itself; the recording keeps running.
      React.useEffect(() => {
        if (s.open !== true) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (store.namesOpen === true) set({ namesOpen: false, namesFocus: '' })
          else if (store.historyOpen === true) set({ historyOpen: false })
          else set({ open: false })
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [s.open])

      if (s.open !== true) return null

      const recording = s.phase === 'recording' || s.phase === 'transcribing'
      const resumable = !recording && s.viewed === null && s.phase === 'idle'
        && s.active === null && s.stoppedAt !== 0 && s.meetingId !== ''
      const speechDetail = s.speech.requesting
        ? (s.speech.totalBytes > 0
          ? `${t('speechDownloading')}（${(s.speech.completedBytes / 1048576).toFixed(1)} / ${(s.speech.totalBytes / 1048576).toFixed(1)} MB）`
          : t('speechPreparing'))
        : ''
      // Speaker recognition is always on while recording; what deserves a line is its
      // first-run download (cues stay unlabelled until it lands) or a failure.
      const speakerDetail = s.speakerModel.phase === 'downloading'
        ? `${t('speakerDownloading')}${s.speakerModel.totalBytes > 0 ? `（${(s.speakerModel.completedBytes / 1048576).toFixed(1)} / ${(s.speakerModel.totalBytes / 1048576).toFixed(1)} MB）` : ''}`
        : s.speakerModel.phase === 'failed'
          ? `${t('speakerFailed')}${s.speakerModel.message === '' ? '' : `：${s.speakerModel.message}`}`
          : ''
      const pill = recording && !s.paused
        ? { style: { ...styles.statusPill, ...styles.statusPillLive }, label: t('recording'), live: true }
        : s.paused
          ? { style: { ...styles.statusPill, ...styles.statusPillPaused }, label: t('pausedLabel'), live: false }
          : { style: styles.statusPill, label: resumable ? t('stoppedLabel') : t('open'), live: false }
      // The editable name a live (or just-stopped) meeting wears: what the person is
      // typing, else the stored name, else the default — its own date + start time.
      const titleValue = typeof s.titleDraft === 'string'
        ? s.titleDraft
        : s.meta.title !== '' ? s.meta.title : defaultTitleOf(s.startedAt)
      // The field exists exactly while a meeting is around to name (recording, paused,
      // or the still-open panel after a stop); an idle fresh panel shows nothing.
      const titleEditable = s.viewed === null && (recording || s.paused || s.seconds > 0)

      return h(Boundary, null, h('div', {
        style: styles.overlay, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('open'),
        onClick: () => { set({ open: false, namesOpen: false, namesFocus: '' }) },
      }, h('div', {
        style: styles.dialog,
        onClick: (event) => event.stopPropagation(),
      }, [
        // Header — the title row: state pill, meeting name, window actions.
        h('div', { key: 'head', style: styles.dialogHead }, [
          h('span', { key: 'pill', style: pill.style }, [
            h('span', {
              key: 'dot',
              style: { ...styles.statusDot, background: pill.live ? 'var(--dsw-alias-state-error-primary)' : 'currentColor' },
              className: pill.live ? 'mn-dot--live' : undefined,
            }),
            pill.label,
          ]),
          s.viewed !== null
            ? h('span', { key: 'title', style: styles.titleStatic }, s.meta.title === '' ? t('unnamed') : s.meta.title)
            : titleEditable
              ? h('input', {
                key: 'title', style: styles.titleInput, value: titleValue, spellCheck: false,
                'aria-label': t('titleEditHint'), title: t('titleEditHint'),
                onChange: (event) => set({ titleDraft: event.target.value }),
                onBlur: () => { void commitTitle() },
                onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
              })
              // An idle fresh panel has no meeting to name yet: nothing in the header.
              : null,
          h('span', { key: 'sp', style: styles.spacer }),
          h('button', {
            key: 'history', type: 'button',
            style: s.historyOpen ? { ...styles.iconBtn, ...styles.iconBtnHover } : styles.iconBtn,
            title: t('historyTitle'), 'aria-label': t('historyTitle'),
            onClick: () => set({ historyOpen: !store.historyOpen }),
          }, h(Icon, { path: ICONS.history })),
          h('button', {
            key: 'close', type: 'button', style: styles.iconBtn,
            title: t('closeDialog'), 'aria-label': t('closeDialog'),
            onClick: () => set({ open: false, namesOpen: false, namesFocus: '' }),
          }, h(Icon, { path: ICONS.close })),
        ]),
        // Controls — their OWN toolbar card under the title, in the reference's style:
        // the current action blue and filled, the others pale-gray (soft).
        s.viewed === null ? h('div', { key: 'controls', style: styles.controlRow }, [
          s.viewed === null && recording ? h(Btn, {
            key: 'pause', type: 'button', variant: s.paused ? 'primary' : 'soft',
            disabled: s.phase === 'starting',
            onClick: () => togglePause(),
          }, s.paused ? t('resume') : t('pause')) : null,
          s.viewed === null && recording ? h(Btn, {
            key: 'stop', type: 'button', variant: 'soft',
            disabled: s.phase === 'starting' || s.pendingStart || s.finishing !== null,
            onClick: () => { void stop() },
          }, t('stop')) : null,
          s.viewed === null && !recording && resumable ? h(Btn, {
            key: 'resume', type: 'button', variant: 'primary', disabled: s.pendingStart,
            onClick: () => { void resumeMeeting() },
          }, s.pendingStart ? t('preparing') : t('resumeMeeting')) : null,
          s.viewed === null && !recording ? h(Btn, {
            key: 'start', type: 'button', variant: resumable ? 'soft' : 'primary', disabled: s.pendingStart,
            onClick: () => { void start() },
          }, s.pendingStart ? t('preparing') : t('start')) : null,
          s.viewed === null && (recording || s.paused || s.seconds > 0)
            ? h('span', { key: 'dur', style: styles.duration },
              `${t('recordingDuration')} ${clock(s.seconds)}`)
            : null,
        ]) : null,
        // Transient messages (errors, notes, finishing, model download): one slim
        // row under the header, rendered ONLY while something to say — never a
        // persistent bar.
        s.error !== '' || s.note !== '' || speechDetail !== '' || speakerDetail !== ''
          || (s.finishing !== null && s.viewed === null)
          ? h('div', { key: 'statusrow', style: styles.statusRow, role: 'status', 'aria-live': 'polite' }, [
            s.error === '' ? null : h('span', { key: 'error', style: styles.error, title: s.error }, `${t('error')}: ${s.error}`),
            s.note === '' ? null : h('span', { key: 'note', style: styles.note, title: s.note }, s.note),
            speechDetail === '' ? null : h('span', { key: 'speech', style: styles.note }, speechDetail),
            speakerDetail === '' ? null : h('span', { key: 'speaker', style: styles.note, title: speakerDetail }, speakerDetail),
            s.finishing === null || s.viewed !== null ? null : h('span', { key: 'fin', style: styles.note },
              s.finishing.done === true
                ? `${t('stopFinished')} · ${s.finishing.seconds}s`
                : `${t('stopFinishing')} ${t('stopRemaining')} ${s.finishing.remaining} · ${t('stopElapsed')} ${s.finishing.seconds}s`),
          ]) : null,
        s.summaryDelivery?.error ? h(Btn, { key: 'retry-summary', onClick: async () => {
          try {
            const reply = await post('/summary-retry', { meetingId: s.summaryDelivery.meetingId })
            set({ summaryDelivery: reply.card, error: reply.card.error || '' })
            if (reply.card.sessionId && !reply.card.error && workspaceApi) { set({ open: false }); workspaceApi.openSession(reply.card.sessionId) }
          } catch (error) { set({ error: error.message }) }
        } }, '重试创建纪要会话') : null,
        // Tabs. LIVE recording: a single 实录 tab, so no tab strip at all. While VIEWING
        // a finished meeting (the summary card's expansion) the audio bar sits above the
        // tabs, always visible, and the tabs read 全文转记 / 内容纪要 / 要点.
        s.historyOpen ? h('div', { key: 'tabbar', style: { ...styles.tabs, paddingLeft: 18 } }, [
          h('span', { key: 't', style: { ...styles.label, padding: '6px 12px' } }, t('historyTitle')),
        ]) : s.viewed === null ? null : [
          s.audioName === '' ? null : h('audio', {
            key: 'viewaudio', controls: true, preload: 'none', style: styles.viewAudio,
            src: `${PREFIX}/audio?name=${encodeURIComponent(s.audioName)}&rev=${s.audioRev}`,
          }),
          h('div', { key: 'tabbar', style: styles.tabs },
            [['transcript', 'viewTabTranscript'], ['minutes', 'viewTabMinutes'], ['notes', 'viewTabNotes']].map(([id, key]) => h(Btn, {
              key: id, type: 'button', variant: s.tab === id ? 'tab-active' : 'tab',
              onClick: () => set({ tab: id }),
            }, t(key)))),
        ],
        // Body
        h('div', { key: 'body', style: styles.body }, [
          s.viewed === null ? null : h('div', { key: 'viewbanner', style: styles.banner }, [
            h('span', { key: 'label' }, `${t('historyViewing')} · ${s.meta.title === '' ? t('unnamed') : s.meta.title}`),
            h('span', { key: 'sp', style: styles.spacer }),
            h(Btn, { key: 'back', type: 'button', variant: 'small', onClick: () => { void closeViewed() } }, t('historyBack')),
          ]),
          s.historyOpen
            ? h(HistoryTab, { key: 'history', t })
            : s.viewed === null
              // Live recording: transcript (left) + the collapsible notes pad (right).
              ? h('div', { key: 'live', style: styles.contentRow }, [
                h('div', { key: 'transcript', style: styles.transcriptPane }, h(TranscriptTab, { t })),
                // The collapse/expand seat BETWEEN the two panes; when the pad is
                // collapsed the strip stays at the dialog's right edge.
                h('button', {
                  key: 'notes-toggle', type: 'button', style: styles.notesToggle,
                  title: s.notesOpen === true ? t('notesCollapse') : t('notesExpand'),
                  'aria-label': s.notesOpen === true ? t('notesCollapse') : t('notesExpand'),
                  'aria-expanded': s.notesOpen === true,
                  onClick: () => set({ notesOpen: !(store.notesOpen === true) }),
                }, h('span', { key: 'glyph', style: styles.notesToggleGlyph }, s.notesOpen === true ? '›' : '‹')),
                s.notesOpen === true ? h(NotesPanel, { key: 'notes', t }) : null,
              ])
              : s.tab === 'transcript' ? h(TranscriptTab, { key: 'transcript', t })
                : s.tab === 'notes' ? h(NotesTab, { key: 'notes', t })
                  : h(MinutesTab, { key: 'minutes', t }),
        ]),
      ])))
    }

    // ── Registration ──────────────────────────────────────────────────────────

    return {
      inject: ['slots', 'locale', 'layout', 'sessions', 'uiWorkspace', 'uiConversation', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        try {
          layoutApi = ctx.get('layout') ?? null
        } catch {
          layoutApi = null
        }
        try {
          sessionsApi = ctx.get('sessions') ?? null
        } catch {
          sessionsApi = null
        }
        workspaceApi = ctx.get('uiWorkspace')
        sidebarApi = ctx.get('sidebarRight')
        ctx.effect(() => ctx.get('sidebarRightTabs').register({
          id: 'meeting-notes.details', kind: 'meeting-notes', priority: 'extension',
          title: () => '会议纪要',
          patterns: ['dsh-resource://meeting-notes/**'],
          canOpen: (address) => address.startsWith('dsh-resource://meeting-notes/'),
        }), 'meeting-notes: right pane type')
        // The pane body: the seat injects its own `tabInfo` hook (handed to the
        // component as the `useTabInfo` prop); a plugin cannot invent hooks here.
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: 'meeting-notes.details', locale: NS,
        }, MeetingDetailPane))
        // A plugin-owned log record renders the card, never a synthetic user prompt
        // or assistant message. Model reasoning chunks never enter this Session.
        ctx.effect(() => ctx.get('uiConversation').events.register({
          kind: 'meeting-notes-card', target: 'chat',
          match: (event) => event.type === 'plugin:meeting-notes/card' && event.ignorable === true && typeof event.data?.meetingId === 'string'
            ? { id: event.data.meetingId, role: 'start' } : null,
          start: (_context, match) => ({ meetingId: match.event.data.meetingId }),
          buildViewNode: (context) => {
            const first = context.start ?? context.matches[0]
            if (!first) return null
            return { key: context.key, kind: 'meeting-notes-card', id: context.id, target: 'chat',
              anchorSeq: first.event.seq, location: first.location, visibility: 'visible', data: context.state ?? { meetingId: context.id } }
          },
        }), 'meeting-notes: durable conversation card')
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'meeting-notes-card' }, MeetingSummaryCard))
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'meeting-notes: dictionaries')
        const t = ctx.locale.bind(NS)

        // The single entry point: a chip INSIDE the composer tool row (left of the
        // submit side), in the style of the meeting-record buttons in Doubao / Feishu.
        // The ambient dock row below the card belongs to the shell's statistics.
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'meeting-notes.record',
          order: 100,
          locale: NS,
          label: () => t('open'),
        }, MeetingDockButton))

        // The record dialog: a frame-wide overlay, not a resident panel.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'meeting-notes.dialog',
          order: 100,
          locale: NS,
          label: () => t('open'),
        }, MeetingOverlay))

        // The left-sidebar entry (right below the old plugin's 会议管理, order 20):
        // clicking it selects the launcher page below, which pops this same dialog.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'meeting-notes',
          order: 21,
          locale: NS,
          label: () => t('panelLabel'),
        }, MeetingNotesPanelIcon))

        // The launcher page the sidebar entry addresses; see MeetingNotesLauncher.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'meeting-notes',
          locale: NS,
        }, MeetingNotesLauncher))

        // The plugin's page inside DSH's settings (设置 → 会议记录): everything the
        // record dialog's former gear dialog carried, moved wholesale. The record
        // dialog itself stays recording-only; `slots.inject` keeps the section alive
        // only while the settings shell (which declares the slot) is mounted.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'meeting-notes',
          order: 30,
          label: () => t('settingsNav'),
          locale: NS,
          inject: () => ({ t }),
        }, (ownerProps = {}) => h(MeetingSettingsSection, ownerProps)))

        // The section's nav glyph (dsh ≥ 0.2.2 declares the seat): the same mic the
        // sidebar panel wears, so both entries read as one feature. Hosts without
        // the seat keep their own gear fallback — no stand-in is needed here.
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register(
          { name: 'settings.section.icon', id: 'meeting-notes' },
          (owner = {}) => h(MeetingNotesPanelIcon, { size: owner.size ?? 16 }),
        ))

        // A start the agent asked for opens the dialog; the dialog's own poll starts.
        ctx.effect(() => {
          const timer = window.setInterval(() => {
            void watchPendingStart()
          }, 2000)
          return () => window.clearInterval(timer)
        }, 'meeting-notes: pending start watcher')

        // Speaker labels are on by default: prepare the voice model once, quietly.
        ctx.effect(() => {
          void settleSpeakers()
          return () => undefined
        }, 'meeting-notes: speaker readiness')

        // The audio-source picker follows the devices this machine currently has:
        // a plugged-in headset or a newly installed loopback device appears at once.
        ctx.effect(() => {
          void refreshInputDevices()
          const onChange = () => { void refreshInputDevices() }
          navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
          return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
        }, 'meeting-notes: input devices')

      },

      // Test-only handles for the client smoke (default-name rule, the header field's
      // backing state and its commit path). The host loader only reads inject/apply.
      __test: { defaultTitleOf, store, commitTitle, shouldPartial, shouldFlush, flush, sendPartial },
    }
  },
})
