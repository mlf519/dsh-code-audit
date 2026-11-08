package com.interviewcopilot.core.workflow

import com.interviewcopilot.core.asr.AsrEngine
import com.interviewcopilot.core.asr.AsrRequest
import com.interviewcopilot.core.audio.AudioFormatSpec
import com.interviewcopilot.core.model.Speakers
import com.interviewcopilot.core.model.TranscriptLine
import com.interviewcopilot.core.network.LlmEvent
import com.interviewcopilot.core.network.LlmMessage
import com.interviewcopilot.core.network.LlmRequest
import com.interviewcopilot.core.network.UnifiedLlmClient
import com.interviewcopilot.core.settings.AsrConfig
import com.interviewcopilot.core.settings.LlmConfig
import kotlinx.coroutines.flow.collect

/** 节点间传递数据的键。 */
object NodeKeys {
    const val PCM16 = "pcm16"
    const val FORMAT = "format"
    const val TEXT = "text"
    const val ANSWER = "answer"
}

/** 链路 A 第一段：音频 → 文字（Hanako 里对应 OCR 那一步）。 */
class AsrTranscribeNode(
    private val engine: AsrEngine,
    private val config: AsrConfig,
    private val onTranscript: (String) -> Unit = {},
) : WorkflowNode {

    override val id: String = "asr_transcribe"
    override val name: String = "语音转文字（ASR）"

    override suspend fun run(context: WorkflowContext): NodeOutcome {
        val pcm = context.get<ByteArray>(NodeKeys.PCM16)
            ?: return NodeOutcome.Stop("没有可用音频")
        val format = context.get<AudioFormatSpec>(NodeKeys.FORMAT) ?: AudioFormatSpec()
        val result = engine.transcribe(config, AsrRequest(pcm, format))
        context.put(NodeKeys.TEXT, result.text)
        if (result.text.isNotBlank()) onTranscript(result.text)
        return NodeOutcome.Continue
    }
}

/** 过滤掉 VAD 切出来的空白 / 纯噪声段，避免为无意义内容调用大模型。 */
class TranscriptFilterNode : WorkflowNode {

    override val id: String = "transcript_filter"
    override val name: String = "过滤无效转写"

    override suspend fun run(context: WorkflowContext): NodeOutcome {
        val text = context.get<String>(NodeKeys.TEXT).orEmpty().trim()
        val meaningful = text.count { it.isLetterOrDigit() } >= 2
        return if (meaningful) NodeOutcome.Continue else NodeOutcome.Stop("未识别到有效语音")
    }
}

/** 链路 A 第二段：文字 → 大模型 → 回复。文本增量通过 [onDelta] 实时回调给界面。 */
class LlmAnswerNode(
    private val client: UnifiedLlmClient,
    private val config: LlmConfig,
    private val systemPrompt: String,
    private val history: List<TranscriptLine>,
    private val onDelta: (String) -> Unit,
) : WorkflowNode {

    override val id: String = "llm_answer"
    override val name: String = "大模型生成回复"

    override suspend fun run(context: WorkflowContext): NodeOutcome {
        val question = context.get<String>(NodeKeys.TEXT).orEmpty().trim()
        if (question.isEmpty()) return NodeOutcome.Stop("问题为空")

        val messages = buildList {
            if (systemPrompt.isNotBlank()) {
                add(LlmMessage(LlmMessage.ROLE_SYSTEM, systemPrompt))
            }
            history.takeLast(HISTORY_LIMIT).forEach { add(it.toMessage()) }
            add(LlmMessage(LlmMessage.ROLE_USER, question))
        }

        val buffer = StringBuilder()
        var failure: String? = null
        client.stream(
            config = config,
            request = LlmRequest(
                messages = messages,
                temperature = config.temperature,
                maxTokens = config.maxTokens,
            ),
        ).collect { event ->
            when (event) {
                is LlmEvent.TextDelta -> {
                    buffer.append(event.text)
                    onDelta(buffer.toString())
                }

                is LlmEvent.Failure -> failure = event.message
                is LlmEvent.ToolCall, LlmEvent.Done -> Unit
            }
        }

        failure?.let { throw IllegalStateException(it) }
        context.put(NodeKeys.ANSWER, buffer.toString())
        return NodeOutcome.Continue
    }

    private fun TranscriptLine.toMessage(): LlmMessage = if (speaker == Speakers.INTERVIEWER) {
        LlmMessage(LlmMessage.ROLE_USER, text)
    } else {
        LlmMessage(LlmMessage.ROLE_ASSISTANT, text)
    }

    private companion object {
        const val HISTORY_LIMIT = 6
    }
}
