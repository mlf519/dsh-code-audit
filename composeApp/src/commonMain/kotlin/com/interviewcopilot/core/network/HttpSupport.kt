package com.interviewcopilot.core.network

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.request.header
import io.ktor.client.request.preparePost
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withTimeout

class LlmHttpException(val status: Int, val body: String) :
    RuntimeException("HTTP $status ${body.take(400)}")

/**
 * 读取 SSE 流并把 `data:` 负载逐条吐出。
 * 引擎由各平台依赖提供（Android → OkHttp，Windows → CIO），commonMain 不需要知道。
 */
internal fun HttpClient.sseLines(
    url: String,
    headers: Map<String, String>,
    jsonBody: String,
    firstLineTimeoutMillis: Long,
): Flow<String> = flow {
    preparePost(url) {
        headers.forEach { (name, value) -> header(name, value) }
        contentType(ContentType.Application.Json)
        setBody(jsonBody)
    }.execute { response ->
        if (!response.status.isSuccess()) {
            val text = runCatching { response.bodyAsText() }.getOrElse { "" }
            throw LlmHttpException(response.status.value, text)
        }
        val channel = response.bodyAsChannel()
        var isFirstLine = true
        while (true) {
            val line = try {
                if (isFirstLine) {
                    isFirstLine = false
                    withTimeout(firstLineTimeoutMillis) { channel.readUTF8Line() }
                } else {
                    channel.readUTF8Line()
                }
            } catch (timeout: TimeoutCancellationException) {
                throw LlmHttpException(408, "模型首字超时（${firstLineTimeoutMillis}ms）")
            } ?: break

            val trimmed = line.trim()
            if (!trimmed.startsWith("data:")) continue
            val payload = trimmed.removePrefix("data:").trim()
            if (payload.isEmpty()) continue
            emit(payload)
        }
    }
}

internal fun buildHttpClient(): HttpClient = HttpClient {
    install(WebSockets)
    install(HttpTimeout) {
        requestTimeoutMillis = 180_000
        connectTimeoutMillis = 20_000
        socketTimeoutMillis = 180_000
    }
}
