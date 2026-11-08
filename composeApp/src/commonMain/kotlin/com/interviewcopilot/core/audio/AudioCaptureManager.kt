package com.interviewcopilot.core.audio

import com.interviewcopilot.core.model.AudioSourceType
import com.interviewcopilot.core.util.AppLog

/**
 * 多音频源分发器。对应 Hanako 里「按截屏后端分发」的那一层：
 * 上层只关心“我要从哪拿声音”，具体走 AudioRecord / AudioPlaybackCapture / WASAPI 由后端决定。
 */
class AudioCaptureManager {

    private val backends = mutableMapOf<AudioSourceType, AudioCaptureBackend>()
    private var active: AudioCaptureBackend? = null

    fun support(source: AudioSourceType): CaptureSupport =
        runCatching { backend(source).isSupported() }
            .getOrElse { CaptureSupport(false, it.message ?: "能力探测失败") }

    fun supportAll(): Map<AudioSourceType, CaptureSupport> =
        AudioSourceType.entries.associateWith { support(it) }

    suspend fun start(
        source: AudioSourceType,
        format: AudioFormatSpec = AudioFormatSpec(),
        onFrame: (AudioFrame) -> Unit,
    ) {
        stop()
        val backend = backend(source)
        val support = backend.isSupported()
        if (!support.supported) {
            error(support.reason ?: "音频源 ${source.label} 当前不可用")
        }
        active = backend
        AppLog.d(TAG, "start capture source=${source.name} format=$format")
        backend.start(format, onFrame)
    }

    suspend fun stop() {
        val running = active ?: return
        active = null
        runCatching { running.stop() }
            .onFailure { AppLog.e(TAG, "停止采集失败", it) }
    }

    private fun backend(source: AudioSourceType): AudioCaptureBackend =
        backends.getOrPut(source) { createAudioCaptureBackend(source) }

    private companion object {
        const val TAG = "AudioCapture"
    }
}
