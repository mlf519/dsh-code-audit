package com.interviewcopilot.feature.session

import com.interviewcopilot.core.asr.AsrEngine
import com.interviewcopilot.core.audio.AudioCaptureManager
import com.interviewcopilot.core.audio.AudioFormatSpec
import com.interviewcopilot.core.audio.VadEvent
import com.interviewcopilot.core.audio.VoiceActivitySegmenter
import com.interviewcopilot.core.model.PipelineMode
import com.interviewcopilot.core.model.Speakers
import com.interviewcopilot.core.model.TranscriptLine
import com.interviewcopilot.core.network.UnifiedLlmClient
import com.interviewcopilot.core.overlay.OverlayPresenter
import com.interviewcopilot.core.overlay.OverlayState
import com.interviewcopilot.core.settings.AppSettings
import com.interviewcopilot.core.settings.SettingsStore
import com.interviewcopilot.core.speech.RealtimeEvent
import com.interviewcopilot.core.speech.RealtimeSpeechSession
import com.interviewcopilot.core.util.AppLog
import com.interviewcopilot.core.util.nowMillis
import com.interviewcopilot.core.util.platformName
import com.interviewcopilot.core.workflow.InterviewWorkflows
import com.interviewcopilot.core.workflow.NodeKeys
import com.interviewcopilot.core.workflow.NodeStatus
import com.interviewcopilot.core.workflow.WorkflowCheckpoint
import com.interviewcopilot.core.workflow.WorkflowRunner
import io.ktor.client.HttpClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * 会话编排器：把「采集 → VAD/分段 →（链路 A：ASR→LLM / 链路 B：原生语音大模型）→ 界面 + 浮层」串起来。
 * 两种链路对上层暴露同一个 [state]，界面不需要关心当前走的是哪条。
 */
class InterviewSessionController(
    private val settingsStore: SettingsStore,
    private val audioCapture: AudioCaptureManager,
    private val llmClient: UnifiedLlmClient,
    private val asrEngine: AsrEngine,
    private val http: HttpClient,
    private val overlay: OverlayPresenter,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(SessionUiState())
    val state: StateFlow<SessionUiState> = _state.asStateFlow()

    private val _settings = MutableStateFlow(AppSettings())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    private var captureJob: Job? = null
    private var pipelineJob: Job? = null
    private var segmentQueue: Channel<ByteArray>? = null
    private var realtimeSession: RealtimeSpeechSession? = null

    private var answerSeq: Long = 0
    private var realtimeAnswerId: Long? = null
    private var realtimeQuestion: String = ""

    init {
        scope.launch {
            val loaded = runCatching { settingsStore.load() }
                .onFailure { AppLog.e(TAG, "读取设置失败，使用默认值", it) }
                .getOrElse { AppSettings() }
            _settings.value = loaded
            _state.update { it.copy(mode = loaded.mode, platform = platformName()) }
            refreshCapabilities()
        }
    }

    fun refreshCapabilities() {
        scope.launch {
            _state.update { it.copy(captures = audioCapture.supportAll()) }
        }
    }

    fun updateSettings(transform: (AppSettings) -> AppSettings) {
        val next = transform(_settings.value)
        _settings.value = next
        _state.update { it.copy(mode = next.mode) }
        scope.launch {
            runCatching { settingsStore.save(next) }
                .onFailure { AppLog.e(TAG, "保存设置失败", it) }
        }
    }

    fun dismissError() {
        _state.update { it.copy(error = null) }
    }

    fun start() {
        if (_state.value.running) return
        val settings = _settings.value

        val support = audioCapture.support(settings.audioSource)
        if (!support.supported) {
            _state.update { it.copy(error = support.reason ?: "${settings.audioSource.label} 当前不可用") }
            return
        }
        val missingKey = when (settings.mode) {
            PipelineMode.ASR_THEN_LLM ->
                if (settings.asr.apiKey.isBlank()) "请先在设置里填写 ASR 的 API Key" else null

            PipelineMode.REALTIME_SPEECH ->
                if (settings.realtime.apiKey.isBlank()) "请先在设置里填写语音大模型的 API Key" else null
        }
        if (missingKey != null) {
            _state.update { it.copy(error = missingKey) }
            return
        }

        val format = AudioFormatSpec(sampleRate = settings.sampleRate)
        _state.update {
            it.copy(
                running = true,
                error = null,
                level = 0f,
                mode = settings.mode,
                transcript = emptyList(),
                answers = emptyList(),
                log = emptyList(),
                status = if (settings.mode == PipelineMode.ASR_THEN_LLM) "监听中…" else "连接语音大模型…",
            )
        }
        OverlayState.clear()
        if (settings.display.overlayEnabled) overlay.show()

        when (settings.mode) {
            PipelineMode.ASR_THEN_LLM -> startAsrPipeline(settings, format)
            PipelineMode.REALTIME_SPEECH -> startRealtimePipeline(settings, format)
        }
    }

    fun stop() {
        pipelineJob?.cancel()
        pipelineJob = null
        captureJob?.cancel()
        captureJob = null
        segmentQueue?.close()
        segmentQueue = null
        realtimeSession?.stop()
        realtimeSession = null
        realtimeAnswerId = null
        realtimeQuestion = ""

        scope.launch { runCatching { audioCapture.stop() } }
        _state.update { it.copy(running = false, status = "已停止", level = 0f) }
        overlay.hide()
        OverlayState.hide()
    }

    // ---------- 链路 A：音频 → ASR → 大模型 ----------

    private fun startAsrPipeline(settings: AppSettings, format: AudioFormatSpec) {
        val vad = VoiceActivitySegmenter(settings.vad, format)
        val queue = Channel<ByteArray>(Channel.UNLIMITED)
        segmentQueue = queue

        // 单消费者串行处理，保证「一段一段问、一段一段答」，不会互相覆盖。
        pipelineJob = scope.launch {
            for (pcm in queue) {
                processSegment(settings, format, pcm)
            }
        }

        captureJob = scope.launch {
            try {
                audioCapture.start(settings.audioSource, format) { frame ->
                    when (val event = vad.accept(frame)) {
                        is VadEvent.SpeechStarted -> setStatus("检测到说话…")
                        is VadEvent.SegmentReady -> {
                            setStatus("转写中…")
                            queue.trySend(event.pcm16)
                        }

                        is VadEvent.SegmentDropped -> setStatus("监听中…")
                        null -> Unit
                    }
                    _state.update { it.copy(level = vad.currentLevel) }
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (t: Throwable) {
                onPipelineFailure(t.message ?: t.toString(), fatal = true)
            }
        }
    }

    private suspend fun processSegment(
        settings: AppSettings,
        format: AudioFormatSpec,
        pcm: ByteArray,
    ) {
        val answerId = ++answerSeq
        var question = ""
        var answer = ""
        var published = false

        fun publish(streaming: Boolean, error: String? = null) {
            published = true
            upsertAnswer(
                AnswerBlock(id = answerId, question = question, text = answer, streaming = streaming, error = error),
                keep = settings.display.keepAnswers,
            )
        }

        val runner = WorkflowRunner { checkpoint -> appendLog(checkpoint) }
        val workflow = InterviewWorkflows.asrThenLlm(
            asrEngine = asrEngine,
            asrConfig = settings.asr,
            llmClient = llmClient,
            llmConfig = settings.llm,
            systemPrompt = settings.systemPrompt,
            history = _state.value.transcript,
            onTranscript = { text ->
                question = text
                appendTranscript(text)
            },
            onDelta = { text ->
                answer = text
                publish(streaming = true)
            },
        )

        val result = runner.run(
            workflow = workflow,
            inputs = mapOf(NodeKeys.PCM16 to pcm, NodeKeys.FORMAT to format),
        )
        val failure = result.checkpoints.lastOrNull { it.status == NodeStatus.FAILED }

        when {
            failure != null -> publish(streaming = false, error = failure.message ?: "处理失败")
            published -> publish(streaming = false)
            else -> setStatus("监听中…")
        }
    }

    // ---------- 链路 B：原生语音大模型 ----------

    private fun startRealtimePipeline(settings: AppSettings, format: AudioFormatSpec) {
        val session = RealtimeSpeechSession(http, scope)
        realtimeSession = session
        realtimeAnswerId = null
        realtimeQuestion = ""

        pipelineJob = scope.launch {
            session.events.collect { event -> handleRealtimeEvent(event, settings) }
        }
        captureJob = scope.launch {
            try {
                audioCapture.start(settings.audioSource, format) { frame -> session.appendAudio(frame.pcm16) }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (t: Throwable) {
                onPipelineFailure(t.message ?: t.toString(), fatal = true)
            }
        }
        session.start(settings.realtime, settings.systemPrompt, format.sampleRate)
    }

    private fun handleRealtimeEvent(event: RealtimeEvent, settings: AppSettings) {
        when (event) {
            is RealtimeEvent.Connected -> setStatus("已连接语音大模型，正在聆听…")

            is RealtimeEvent.TranscriptDelta -> upsertPartialTranscript(event.text)

            is RealtimeEvent.TranscriptCompleted -> {
                realtimeQuestion = event.text.trim()
                appendTranscript(event.text)
            }

            is RealtimeEvent.AnswerDelta -> {
                val id = realtimeAnswerId ?: (++answerSeq).also { realtimeAnswerId = it }
                upsertAnswer(
                    AnswerBlock(id, realtimeQuestion, event.text, streaming = true),
                    keep = settings.display.keepAnswers,
                )
            }

            is RealtimeEvent.AnswerDone -> {
                val id = realtimeAnswerId ?: (++answerSeq).also { realtimeAnswerId = it }
                upsertAnswer(
                    AnswerBlock(id, realtimeQuestion, event.text, streaming = false),
                    keep = settings.display.keepAnswers,
                )
                realtimeAnswerId = null
            }

            is RealtimeEvent.Failure -> onPipelineFailure(event.message, fatal = false)

            RealtimeEvent.Closed -> if (_state.value.running) setStatus("语音大模型连接已断开")
        }
    }

    // ---------- 状态写入 ----------

    private fun upsertAnswer(block: AnswerBlock, keep: Int) {
        _state.update { current ->
            val answers = if (current.answers.any { it.id == block.id }) {
                current.answers.map { if (it.id == block.id) block else it }
            } else {
                current.answers + block
            }
            current.copy(answers = answers.takeLast(keep.coerceAtLeast(1)))
        }
        val latest = _state.value.answers.lastOrNull()
        if (latest == null) OverlayState.clear() else OverlayState.show(latest.question, latest.text)
    }

    private fun appendTranscript(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        val line = TranscriptLine(Speakers.INTERVIEWER, trimmed, nowMillis(), final = true)
        _state.update { current ->
            val lines = current.transcript.toMutableList()
            if (lines.lastOrNull()?.final == false) lines.removeAt(lines.lastIndex)
            lines += line
            current.copy(transcript = lines.takeLast(MAX_TRANSCRIPT_LINES))
        }
    }

    private fun upsertPartialTranscript(delta: String) {
        _state.update { current ->
            val lines = current.transcript.toMutableList()
            val last = lines.lastOrNull()
            if (last != null && !last.final) {
                lines[lines.lastIndex] = last.copy(text = last.text + delta)
            } else {
                lines += TranscriptLine(Speakers.INTERVIEWER, delta, nowMillis(), final = false)
            }
            current.copy(transcript = lines.takeLast(MAX_TRANSCRIPT_LINES))
        }
    }

    private fun appendLog(checkpoint: WorkflowCheckpoint) {
        if (checkpoint.status == NodeStatus.RUNNING) return
        val entry = buildString {
            append(checkpoint.nodeName)
            append(" · ")
            append(checkpoint.status.name.lowercase())
            checkpoint.message?.let { append("（").append(it).append("）") }
        }
        _state.update { it.copy(log = (it.log + entry).takeLast(MAX_LOG_LINES)) }
    }

    private fun setStatus(status: String) {
        _state.update { it.copy(status = status) }
    }

    private fun onPipelineFailure(message: String, fatal: Boolean) {
        AppLog.e(TAG, "链路失败: $message")
        _state.update { it.copy(error = message, status = "出错") }
        if (fatal) scope.launch { stop() }
    }

    private companion object {
        const val TAG = "InterviewSession"
        const val MAX_TRANSCRIPT_LINES = 200
        const val MAX_LOG_LINES = 40
    }
}
