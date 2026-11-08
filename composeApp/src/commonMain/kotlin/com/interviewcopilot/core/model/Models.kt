package com.interviewcopilot.core.model

import kotlinx.serialization.Serializable

/** 语音来源。对应 Hanako 里“从哪里拿到题”，这里变成“从哪里拿到声音”。 */
@Serializable
enum class AudioSourceType(val label: String, val hint: String) {
    MIC("麦克风", "采集我自己的声音（本方发言）"),
    SYSTEM_OUTPUT("系统输出", "采集会议 / 通话中对方的声音（Windows WASAPI Loopback、Android AudioPlaybackCapture）"),
    CALL("通话音频", "直接抓取 SIM / 网络电话通路（Android VOICE_CALL，多数机型受系统限制）"),
}

/** 两条语音处理链路，对应 Hanako 的 OCR 链路 / 多模态直传链路。 */
@Serializable
enum class PipelineMode(val label: String, val hint: String) {
    ASR_THEN_LLM("ASR 转写 → 大模型", "音频 → 文字（VAD 分段 + ASR）→ 交给大模型 → 回复"),
    REALTIME_SPEECH("原生语音大模型", "音频直接推给原生语音大模型（OpenAI Realtime 等）→ 直接返回结果"),
}

/** 文本大模型提供方。 */
@Serializable
enum class LlmProviderKind(val label: String) {
    OPENAI_COMPATIBLE("OpenAI 兼容（Chat Completions）"),
    OPENAI_RESPONSES("OpenAI Responses"),
    ANTHROPIC("Anthropic Messages"),
    GEMINI("Google Gemini"),
}

/** 原生语音大模型提供方。 */
@Serializable
enum class RealtimeProviderKind(val label: String) {
    OPENAI_REALTIME("OpenAI Realtime（WebSocket）"),
    GEMINI_LIVE("Gemini Live（未实现）"),
}

/** 一段已定稿 / 正在定稿的转写文本。 */
data class TranscriptLine(
    val speaker: String,
    val text: String,
    val atMillis: Long,
    val final: Boolean = true,
)

/** [TranscriptLine.speaker] 的取值。 */
object Speakers {
    const val INTERVIEWER = "面试官"
    const val ME = "我"
}
