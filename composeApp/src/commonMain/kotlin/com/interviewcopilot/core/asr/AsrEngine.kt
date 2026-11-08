package com.interviewcopilot.core.asr

import com.interviewcopilot.core.audio.AudioFormatSpec
import com.interviewcopilot.core.audio.WavEncoder
import com.interviewcopilot.core.network.LlmHttpException
import com.interviewcopilot.core.settings.AsrConfig
import io.ktor.client.HttpClient
import io.ktor.client.request.forms.formData
import io.ktor.client.request.forms.submitFormWithBinaryData
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class AsrRequest(
    val pcm16: ByteArray,
    val format: AudioFormatSpec,
    val timeoutMillis: Long = 60_000,
)

data class AsrResult(
    val text: String,
    val durationMillis: Int,
)

/** 链路 A 的第一段：音频 → 文字。 */
interface AsrEngine {
    val id: String
    suspend fun transcribe(config: AsrConfig, request: AsrRequest): AsrResult
}

/**
 * OpenAI 兼容的 `/audio/transcriptions`（whisper-1 / gpt-4o-transcribe / 各类本地服务如 faster-whisper-server）。
 * 若需要完全离线，可在同一接口下换成 whisper.cpp 的本地实现，上层无感。
 */
class OpenAiCompatibleAsrEngine(private val http: HttpClient) : AsrEngine {

    override val id: String = "openai-compatible-asr"

    override suspend fun transcribe(config: AsrConfig, request: AsrRequest): AsrResult {
        val url = config.baseUrl.trimEnd('/') + "/audio/transcriptions"
        val wav = WavEncoder.toWav(request.pcm16, request.format)

        val response = http.submitFormWithBinaryData(
            url = url,
            formData = formData {
                append("model", config.model)
                append("response_format", "json")
                if (config.language.isNotBlank()) append("language", config.language)
                if (config.prompt.isNotBlank()) append("prompt", config.prompt)
                append(
                    key = "file",
                    value = wav,
                    headers = Headers.build {
                        append(HttpHeaders.ContentType, "audio/wav")
                        append(HttpHeaders.ContentDisposition, "filename=\"segment.wav\"")
                    },
                )
            },
        ) {
            header(HttpHeaders.Authorization, "Bearer ${config.apiKey}")
        }

        val raw = response.bodyAsText()
        if (!response.status.isSuccess()) {
            throw LlmHttpException(response.status.value, raw)
        }

        val text = runCatching {
            kotlinx.serialization.json.Json.parseToJsonElement(raw)
                .jsonObject["text"]?.jsonPrimitive?.content
        }.getOrNull().orEmpty()

        return AsrResult(
            text = text.trim(),
            durationMillis = request.format.millisForBytes(request.pcm16.size),
        )
    }
}
