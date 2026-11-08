package com.interviewcopilot.core.workflow

import com.interviewcopilot.core.asr.AsrEngine
import com.interviewcopilot.core.model.TranscriptLine
import com.interviewcopilot.core.network.UnifiedLlmClient
import com.interviewcopilot.core.settings.AsrConfig
import com.interviewcopilot.core.settings.LlmConfig

/** 两条链路的工作流装配。链路 B（原生语音大模型）是长连接会话，不套用一次性工作流。 */
object InterviewWorkflows {

    const val ASR_THEN_LLM_ID: String = "asr_then_llm"

    /**
     * 链路 A：音频 → ASR 转写 → 过滤噪声 → 大模型生成回复。
     *
     * @param onTranscript 转写定稿回调（用于界面展示与写入上下文）
     * @param onDelta 回复文本增量回调（用于流式展示）
     */
    fun asrThenLlm(
        asrEngine: AsrEngine,
        asrConfig: AsrConfig,
        llmClient: UnifiedLlmClient,
        llmConfig: LlmConfig,
        systemPrompt: String,
        history: List<TranscriptLine>,
        onTranscript: (String) -> Unit,
        onDelta: (String) -> Unit,
    ): Workflow = Workflow(
        id = ASR_THEN_LLM_ID,
        name = "ASR 转写 → 大模型",
        nodes = listOf(
            AsrTranscribeNode(asrEngine, asrConfig, onTranscript),
            TranscriptFilterNode(),
            LlmAnswerNode(llmClient, llmConfig, systemPrompt, history, onDelta),
        ),
    )
}
