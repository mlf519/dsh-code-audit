package com.interviewcopilot.core.network

import com.interviewcopilot.core.model.LlmProviderKind
import com.interviewcopilot.core.network.adapters.AnthropicClient
import com.interviewcopilot.core.network.adapters.GeminiClient
import com.interviewcopilot.core.network.adapters.OpenAiCompatibleClient
import com.interviewcopilot.core.network.adapters.OpenAiResponsesClient
import com.interviewcopilot.core.settings.LlmConfig
import io.ktor.client.HttpClient
import kotlinx.coroutines.flow.Flow

/**
 * 按 [LlmConfig.kind] 分发到具体协议适配器。
 * 上层只消费统一的 [LlmEvent]，换提供方不需要改业务代码 —— 与 Hanako 的 ProviderConfigResolver 思路一致。
 */
class UnifiedLlmClient(private val http: HttpClient) {

    private val openAiCompatible = OpenAiCompatibleClient(http)
    private val openAiResponses = OpenAiResponsesClient(http)
    private val anthropic = AnthropicClient(http)
    private val gemini = GeminiClient(http)

    fun stream(config: LlmConfig, request: LlmRequest): Flow<LlmEvent> = when (config.kind) {
        LlmProviderKind.OPENAI_COMPATIBLE -> openAiCompatible.stream(config, request)
        LlmProviderKind.OPENAI_RESPONSES -> openAiResponses.stream(config, request)
        LlmProviderKind.ANTHROPIC -> anthropic.stream(config, request)
        LlmProviderKind.GEMINI -> gemini.stream(config, request)
    }
}
