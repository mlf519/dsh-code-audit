package com.interviewcopilot.core.network

import com.interviewcopilot.core.settings.LlmConfig
import kotlinx.coroutines.flow.Flow

/** 与大模型交互的统一事件。任何提供方最终都归一成这三种（+失败），对应 Hanako 的做法。 */
sealed interface LlmEvent {
    data class TextDelta(val text: String) : LlmEvent
    data class ToolCall(val id: String, val name: String, val argumentsJson: String) : LlmEvent
    data object Done : LlmEvent
    data class Failure(val message: String, val cause: Throwable? = null) : LlmEvent
}

data class LlmMessage(val role: String, val content: String) {
    companion object {
        const val ROLE_SYSTEM = "system"
        const val ROLE_USER = "user"
        const val ROLE_ASSISTANT = "assistant"
    }
}

data class LlmRequest(
    val messages: List<LlmMessage>,
    val temperature: Double = 0.3,
    val maxTokens: Int? = 700,
    /** 首字延迟看门狗：超时直接判失败，避免界面一直“思考中”。 */
    val firstDeltaTimeoutMillis: Long = 25_000,
)

interface LlmClient {
    fun stream(config: LlmConfig, request: LlmRequest): Flow<LlmEvent>
}
