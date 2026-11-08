package com.interviewcopilot.core.network.adapters

import com.interviewcopilot.core.network.LlmClient
import com.interviewcopilot.core.network.LlmEvent
import com.interviewcopilot.core.network.LlmMessage
import com.interviewcopilot.core.network.LlmRequest
import com.interviewcopilot.core.network.sseLines
import com.interviewcopilot.core.settings.LlmConfig
import io.ktor.client.HttpClient
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.coroutines.cancellation.CancellationException

private class ToolCallAccumulator {
    var id: String = ""
    var name: String = ""
    var arguments: String = ""
}

/** OpenAI 兼容协议（`/chat/completions`）：覆盖 OpenAI / DeepSeek / 通义 / 各类私有网关。 */
class OpenAiCompatibleClient(private val http: HttpClient) : LlmClient {

    override fun stream(config: LlmConfig, request: LlmRequest): Flow<LlmEvent> = flow {
        val url = config.baseUrl.trimEnd('/') + "/chat/completions"
        val body = buildJsonObject {
            put("model", config.model)
            put("stream", true)
            put("temperature", config.temperature)
            request.maxTokens?.let { put("max_tokens", it) }
            putJsonArray("messages") {
                request.messages.forEach { message ->
                    addJsonObject {
                        put("role", message.role)
                        put("content", message.content)
                    }
                }
            }
        }.toString()

        val headers = mapOf("Authorization" to "Bearer ${config.apiKey}")
        val pendingTools = linkedMapOf<Int, ToolCallAccumulator>()

        try {
            http.sseLines(url, headers, body, request.firstDeltaTimeoutMillis).collect { payload ->
                if (payload == "[DONE]") return@collect
                val obj = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(payload).jsonObject }
                    .getOrNull() ?: return@collect

                val choice = obj["choices"]?.jsonArray?.firstOrNull()?.jsonObject ?: return@collect
                val delta = choice["delta"]?.jsonObject

                delta?.get("content")?.jsonPrimitive?.contentOrNull
                    ?.takeIf { it.isNotEmpty() }
                    ?.let { emit(LlmEvent.TextDelta(it)) }

                delta?.get("tool_calls")?.jsonArray?.forEach { element ->
                    val call = element.jsonObject
                    val index = call["index"]?.jsonPrimitive?.intOrNull ?: 0
                    val acc = pendingTools.getOrPut(index) { ToolCallAccumulator() }
                    call["id"]?.jsonPrimitive?.contentOrNull?.let { acc.id = it }
                    call["function"]?.jsonObject?.let { fn ->
                        fn["name"]?.jsonPrimitive?.contentOrNull?.let { acc.name = it }
                        fn["arguments"]?.jsonPrimitive?.contentOrNull?.let { acc.arguments += it }
                    }
                }

                if (choice["finish_reason"]?.jsonPrimitive?.contentOrNull == "tool_calls") {
                    pendingTools.forEach { (index, acc) ->
                        emit(LlmEvent.ToolCall(acc.id.ifEmpty { "tool_$index" }, acc.name, acc.arguments))
                    }
                    pendingTools.clear()
                }
            }
            emit(LlmEvent.Done)
        } catch (t: Throwable) {
            if (t is CancellationException) throw t
            emit(LlmEvent.Failure(t.message ?: "大模型请求失败", t))
        }
    }
}

/** OpenAI Responses 协议（`/responses`）。 */
class OpenAiResponsesClient(private val http: HttpClient) : LlmClient {

    override fun stream(config: LlmConfig, request: LlmRequest): Flow<LlmEvent> = flow {
        val url = config.baseUrl.trimEnd('/') + "/responses"
        val instructions = request.messages
            .filter { it.role == LlmMessage.ROLE_SYSTEM }
            .joinToString("\n") { it.content }

        val body = buildJsonObject {
            put("model", config.model)
            put("stream", true)
            put("temperature", config.temperature)
            if (instructions.isNotEmpty()) put("instructions", instructions)
            request.maxTokens?.let { put("max_output_tokens", it) }
            putJsonArray("input") {
                request.messages.filter { it.role != LlmMessage.ROLE_SYSTEM }.forEach { message ->
                    addJsonObject {
                        put("role", message.role)
                        putJsonArray("content") {
                            addJsonObject {
                                put("type", "input_text")
                                put("text", message.content)
                            }
                        }
                    }
                }
            }
        }.toString()

        val headers = mapOf("Authorization" to "Bearer ${config.apiKey}")
        var done = false
        try {
            http.sseLines(url, headers, body, request.firstDeltaTimeoutMillis).collect { payload ->
                val obj = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(payload).jsonObject }
                    .getOrNull() ?: return@collect
                when (obj["type"]?.jsonPrimitive?.contentOrNull) {
                    "response.output_text.delta" ->
                        obj["delta"]?.jsonPrimitive?.contentOrNull
                            ?.takeIf { it.isNotEmpty() }
                            ?.let { emit(LlmEvent.TextDelta(it)) }

                    "response.completed" -> {
                        done = true
                        emit(LlmEvent.Done)
                    }
                }
            }
            if (!done) emit(LlmEvent.Done)
        } catch (t: Throwable) {
            if (t is CancellationException) throw t
            emit(LlmEvent.Failure(t.message ?: "大模型请求失败", t))
        }
    }
}

/** Anthropic Messages 协议。 */
class AnthropicClient(private val http: HttpClient) : LlmClient {

    override fun stream(config: LlmConfig, request: LlmRequest): Flow<LlmEvent> = flow {
        val url = config.baseUrl.trimEnd('/') + "/messages"
        val system = request.messages
            .filter { it.role == LlmMessage.ROLE_SYSTEM }
            .joinToString("\n") { it.content }

        val body = buildJsonObject {
            put("model", config.model)
            put("stream", true)
            put("max_tokens", request.maxTokens ?: 700)
            put("temperature", request.temperature)
            if (system.isNotEmpty()) put("system", system)
            putJsonArray("messages") {
                request.messages.filter { it.role != LlmMessage.ROLE_SYSTEM }.forEach { message ->
                    addJsonObject {
                        put("role", message.role)
                        put("content", message.content)
                    }
                }
            }
        }.toString()

        val headers = mapOf(
            "x-api-key" to config.apiKey,
            "anthropic-version" to "2023-06-01",
        )
        var done = false
        try {
            http.sseLines(url, headers, body, request.firstDeltaTimeoutMillis).collect { payload ->
                val obj = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(payload).jsonObject }
                    .getOrNull() ?: return@collect
                when (obj["type"]?.jsonPrimitive?.contentOrNull) {
                    "content_block_delta" ->
                        obj["delta"]?.jsonObject?.get("text")?.jsonPrimitive?.contentOrNull
                            ?.takeIf { it.isNotEmpty() }
                            ?.let { emit(LlmEvent.TextDelta(it)) }

                    "message_stop" -> {
                        done = true
                        emit(LlmEvent.Done)
                    }
                }
            }
            if (!done) emit(LlmEvent.Done)
        } catch (t: Throwable) {
            if (t is CancellationException) throw t
            emit(LlmEvent.Failure(t.message ?: "大模型请求失败", t))
        }
    }
}

/** Google Gemini `streamGenerateContent`。 */
class GeminiClient(private val http: HttpClient) : LlmClient {

    override fun stream(config: LlmConfig, request: LlmRequest): Flow<LlmEvent> = flow {
        val base = config.baseUrl.trimEnd('/')
        val url = "$base/models/${config.model}:streamGenerateContent?alt=sse"

        val system = request.messages
            .filter { it.role == LlmMessage.ROLE_SYSTEM }
            .joinToString("\n") { it.content }

        val body = buildJsonObject {
            if (system.isNotEmpty()) {
                putJsonObject("systemInstruction") {
                    putJsonArray("parts") { addJsonObject { put("text", system) } }
                }
            }
            putJsonArray("contents") {
                request.messages.filter { it.role != LlmMessage.ROLE_SYSTEM }.forEach { message ->
                    addJsonObject {
                        put("role", if (message.role == LlmMessage.ROLE_ASSISTANT) "model" else "user")
                        putJsonArray("parts") { addJsonObject { put("text", message.content) } }
                    }
                }
            }
            putJsonObject("generationConfig") {
                put("temperature", config.temperature)
                request.maxTokens?.let { put("maxOutputTokens", it) }
            }
        }.toString()

        val headers = mapOf("x-goog-api-key" to config.apiKey)
        try {
            http.sseLines(url, headers, body, request.firstDeltaTimeoutMillis).collect { payload ->
                val obj = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(payload).jsonObject }
                    .getOrNull() ?: return@collect
                val parts = obj["candidates"]?.jsonArray?.firstOrNull()?.jsonObject
                    ?.get("content")?.jsonObject
                    ?.get("parts")?.jsonArray ?: return@collect
                parts.forEach { part ->
                    part.jsonObject["text"]?.jsonPrimitive?.contentOrNull
                        ?.takeIf { it.isNotEmpty() }
                        ?.let { emit(LlmEvent.TextDelta(it)) }
                }
            }
            emit(LlmEvent.Done)
        } catch (t: Throwable) {
            if (t is CancellationException) throw t
            emit(LlmEvent.Failure(t.message ?: "大模型请求失败", t))
        }
    }
}
