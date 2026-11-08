package com.interviewcopilot.core.speech

import com.interviewcopilot.core.audio.PcmResampler
import com.interviewcopilot.core.model.RealtimeProviderKind
import com.interviewcopilot.core.settings.RealtimeConfig
import com.interviewcopilot.core.util.AppLog
import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/** 原生语音大模型（链路 B）下行事件，统一成与 [com.interviewcopilot.core.network.LlmEvent] 同构的形态。 */
sealed interface RealtimeEvent {
    data object Connected : RealtimeEvent
    data class TranscriptDelta(val text: String) : RealtimeEvent
    data class TranscriptCompleted(val text: String) : RealtimeEvent
    data class AnswerDelta(val text: String) : RealtimeEvent
    data class AnswerDone(val text: String) : RealtimeEvent
    data class Failure(val message: String) : RealtimeEvent
    data object Closed : RealtimeEvent
}

private val RealtimeJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
}

/**
 * 链路 B：音频不经 ASR，直接推给原生语音大模型，由模型侧完成「听 + 答」。
 * 目前实现 OpenAI Realtime（WebSocket + pcm16 上行）；Gemini Live 走同一接口，后续补适配即可。
 *
 * 上行音频由 [appendAudio] 投递，内部重采样到 [RealtimeConfig.sampleRate] 后 base64 编码发送。
 */
class RealtimeSpeechSession(
    private val http: HttpClient,
    private val scope: CoroutineScope,
) {
    private val _events = MutableSharedFlow<RealtimeEvent>(replay = 0, extraBufferCapacity = 256)
    val events: SharedFlow<RealtimeEvent> = _events.asSharedFlow()

    private var audioChannel: Channel<ByteArray>? = null
    private var controlChannel: Channel<String>? = null
    private var job: Job? = null

    private var sourceSampleRate: Int = 16_000
    private val answerBuffer = StringBuilder()

    val isRunning: Boolean get() = job?.isActive == true

    /**
     * @param sourceSampleRate 采集侧实际采样率，用于重采样到 [RealtimeConfig.sampleRate]。
     */
    fun start(config: RealtimeConfig, instructions: String, sampleRate: Int) {
        if (isRunning) return
        this.sourceSampleRate = sampleRate
        answerBuffer.setLength(0)
        audioChannel = Channel(Channel.BUFFERED)
        controlChannel = Channel(Channel.BUFFERED)
        job = scope.launch {
            try {
                runSession(config, instructions)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (t: Throwable) {
                AppLog.e(TAG, "realtime session failed", t)
                _events.tryEmit(RealtimeEvent.Failure(t.message ?: t.toString()))
                _events.tryEmit(RealtimeEvent.Closed)
            }
        }
    }

    /** 投递一帧 PCM16（采集原始采样率）。通道满时直接丢弃，避免阻塞采集线程。 */
    fun appendAudio(pcm16: ByteArray) {
        audioChannel?.trySend(pcm16)
    }

    /** 手动触发一次回答（server_vad 已自动应答时不必调用，可用于手动追问）。 */
    fun requestResponse() {
        controlChannel?.trySend("""{"type":"response.create"}""")
    }

    fun stop() {
        job?.cancel()
        job = null
        audioChannel?.close()
        audioChannel = null
        controlChannel?.close()
        controlChannel = null
    }

    private suspend fun runSession(config: RealtimeConfig, instructions: String) {
        if (config.kind != RealtimeProviderKind.OPENAI_REALTIME) {
            _events.tryEmit(RealtimeEvent.Failure("${config.kind.label} 尚未实现"))
            _events.tryEmit(RealtimeEvent.Closed)
            return
        }
        if (config.apiKey.isBlank()) {
            _events.tryEmit(RealtimeEvent.Failure("未配置语音大模型 API Key"))
            _events.tryEmit(RealtimeEvent.Closed)
            return
        }

        val separator = if (config.url.contains('?')) '&' else '?'
        val url = config.url.trimEnd('/') + separator + "model=" + config.model

        val session = http.webSocketSession(
            urlString = url,
            block = {
                header(HttpHeaders.Authorization, "Bearer ${config.apiKey}")
                header("OpenAI-Beta", "realtime=v1")
            },
        )
        try {
            with(session) {
                send(Frame.Text(sessionUpdateJson(instructions)))
                val audioPump = launch { pumpAudio(config) }
                val controlPump = launch { pumpControl() }
                try {
                    for (frame in incoming) {
                        val text = (frame as? Frame.Text)?.readText() ?: continue
                        handleIncoming(text)
                    }
                } finally {
                    audioPump.cancel()
                    controlPump.cancel()
                }
            }
        } finally {
            runCatching { session.close() }
            _events.tryEmit(RealtimeEvent.Closed)
        }
    }

    private suspend fun DefaultClientWebSocketSession.pumpAudio(config: RealtimeConfig) {
        val channel = audioChannel ?: return
        for (chunk in channel) {
            val pcm = if (sourceSampleRate == config.sampleRate) {
                chunk
            } else {
                PcmResampler.resample(chunk, sourceSampleRate, config.sampleRate, channels = 1)
            }
            if (pcm.isEmpty()) continue
            send(Frame.Text(appendAudioJson(pcm)))
        }
    }

    private suspend fun DefaultClientWebSocketSession.pumpControl() {
        val channel = controlChannel ?: return
        for (message in channel) {
            send(Frame.Text(message))
        }
    }

    private fun handleIncoming(raw: String) {
        val obj = runCatching { RealtimeJson.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        when (obj["type"]?.jsonPrimitive?.content) {
            "session.created", "session.updated" -> _events.tryEmit(RealtimeEvent.Connected)

            "response.text.delta", "response.output_text.delta", "response.audio_transcript.delta" ->
                obj["delta"]?.jsonPrimitive?.content?.let {
                    answerBuffer.append(it)
                    _events.tryEmit(RealtimeEvent.AnswerDelta(answerBuffer.toString()))
                }

            "response.done" -> {
                val answer = answerBuffer.toString()
                answerBuffer.setLength(0)
                _events.tryEmit(RealtimeEvent.AnswerDone(answer))
            }

            "conversation.item.input_audio_transcription.delta" ->
                obj["delta"]?.jsonPrimitive?.content?.let {
                    _events.tryEmit(RealtimeEvent.TranscriptDelta(it))
                }

            "conversation.item.input_audio_transcription.completed" ->
                obj["transcript"]?.jsonPrimitive?.content?.let {
                    _events.tryEmit(RealtimeEvent.TranscriptCompleted(it))
                }

            "error" -> {
                val message = obj["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content ?: raw
                _events.tryEmit(RealtimeEvent.Failure(message))
            }
        }
    }

    private companion object {
        const val TAG = "RealtimeSpeech"
    }
}

/** OpenAI Realtime 的 `input_audio_format: pcm16` 即 24kHz 单声道，采样率由会话约定，不上送。 */
private fun sessionUpdateJson(instructions: String): String = buildJsonObject {
    put("type", "session.update")
    putJsonObject("session") {
        if (instructions.isNotBlank()) put("instructions", instructions)
        putJsonArray("modalities") { add(JsonPrimitive("text")) }
        put("input_audio_format", "pcm16")
        putJsonObject("input_audio_transcription") {
            put("model", "whisper-1")
        }
        putJsonObject("turn_detection") {
            put("type", "server_vad")
            put("threshold", 0.5)
            put("prefix_padding_ms", 300)
            put("silence_duration_ms", 600)
        }
    }
}.toString()

@OptIn(ExperimentalEncodingApi::class)
private fun appendAudioJson(pcm16: ByteArray): String = buildJsonObject {
    put("type", "input_audio_buffer.append")
    put("audio", Base64.Default.encode(pcm16))
}.toString()
