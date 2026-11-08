package com.interviewcopilot.core.settings

import com.interviewcopilot.core.audio.VadConfig
import com.interviewcopilot.core.model.AudioSourceType
import com.interviewcopilot.core.model.LlmProviderKind
import com.interviewcopilot.core.model.PipelineMode
import com.interviewcopilot.core.model.RealtimeProviderKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class LlmConfig(
    val kind: LlmProviderKind = LlmProviderKind.OPENAI_COMPATIBLE,
    val baseUrl: String = "https://api.openai.com/v1",
    val apiKey: String = "",
    val model: String = "gpt-4o-mini",
    val temperature: Double = 0.3,
    val maxTokens: Int = 700,
)

@Serializable
data class AsrConfig(
    val baseUrl: String = "https://api.openai.com/v1",
    val apiKey: String = "",
    val model: String = "whisper-1",
    val language: String = "zh",
    /** 提示词，可放专业术语，提升识别准确度。 */
    val prompt: String = "",
)

@Serializable
data class RealtimeConfig(
    val kind: RealtimeProviderKind = RealtimeProviderKind.OPENAI_REALTIME,
    val url: String = "wss://api.openai.com/v1/realtime",
    val apiKey: String = "",
    val model: String = "gpt-4o-realtime-preview",
    /** 采集侧送给语音大模型的采样率，OpenAI Realtime 只接受 24kHz。 */
    val sampleRate: Int = 24_000,
)

@Serializable
data class DisplayConfig(
    /** 回复浮层是否置顶（Android 悬浮窗 / Windows 窗口置顶）。 */
    val overlayEnabled: Boolean = true,
    val fontSizeSp: Int = 16,
    val maxLines: Int = 8,
    val showTranscript: Boolean = true,
    /** 随问随答的回答条数上限，避免越堆越长。 */
    val keepAnswers: Int = 8,
)

@Serializable
data class AppSettings(
    val schemaVersion: Int = CURRENT_SCHEMA_VERSION,
    val mode: PipelineMode = PipelineMode.ASR_THEN_LLM,
    val audioSource: AudioSourceType = AudioSourceType.SYSTEM_OUTPUT,
    val sampleRate: Int = 16_000,
    val chunkMillis: Int = 100,
    val llm: LlmConfig = LlmConfig(),
    val asr: AsrConfig = AsrConfig(),
    val realtime: RealtimeConfig = RealtimeConfig(),
    val vad: VadConfig = VadConfig(),
    val display: DisplayConfig = DisplayConfig(),
    val systemPrompt: String = DEFAULT_INTERVIEW_PROMPT,
) {
    companion object {
        const val CURRENT_SCHEMA_VERSION: Int = 1
    }
}

val DEFAULT_INTERVIEW_PROMPT: String = """
你是一名实时面试辅助助手。用户正在参加电话或在线会议形式的面试。
你会收到面试官说话的实时转写文本。请：
1. 用简体中文，先给出可以直接照着念的回答要点（不超过 5 条，每条一行，尽量短）。
2. 必要时补充一句“如果被追问可以这样说”。
3. 不要复述问题，不要解释你在做什么，直接给答案。
4. 如果转写明显是噪音或无意义内容，只回复“（未识别到有效问题）”。
""".trimIndent()

/** 设置持久化。Android 走 SharedPreferences，Windows 走用户目录下的 JSON 文件。 */
interface SettingsStore {
    suspend fun load(): AppSettings
    suspend fun save(settings: AppSettings)
}

expect fun createSettingsStore(): SettingsStore

/** 全局 JSON 配置：宽松解析 + 默认值，天然兼容未来的字段增删（对应 Hanako 的版本化 JSON blob）。 */
val SettingsJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    encodeDefaults = true
    prettyPrint = true
}
