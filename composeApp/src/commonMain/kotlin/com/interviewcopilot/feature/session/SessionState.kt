package com.interviewcopilot.feature.session

import com.interviewcopilot.core.audio.CaptureSupport
import com.interviewcopilot.core.model.AudioSourceType
import com.interviewcopilot.core.model.PipelineMode
import com.interviewcopilot.core.model.TranscriptLine
import com.interviewcopilot.core.util.platformName

/** 一条回答（一问一答）。[streaming] 为 true 时界面显示光标。 */
data class AnswerBlock(
    val id: Long,
    val question: String,
    val text: String = "",
    val streaming: Boolean = true,
    val error: String? = null,
)

data class SessionUiState(
    val running: Boolean = false,
    val status: String = "就绪",
    val level: Float = 0f,
    val mode: PipelineMode = PipelineMode.ASR_THEN_LLM,
    val transcript: List<TranscriptLine> = emptyList(),
    val answers: List<AnswerBlock> = emptyList(),
    val log: List<String> = emptyList(),
    val error: String? = null,
    val platform: String = platformName(),
    val captures: Map<AudioSourceType, CaptureSupport> = emptyMap(),
)
