package com.interviewcopilot.core.audio

import com.interviewcopilot.core.model.AudioSourceType

/** 采集参数。默认 16kHz / 单声道 / PCM16，这是 ASR 与语音大模型最通用的输入格式。 */
data class AudioFormatSpec(
    val sampleRate: Int = 16_000,
    val channels: Int = 1,
    val bitsPerSample: Int = 16,
) {
    val bytesPerFrame: Int get() = channels * bitsPerSample / 8

    fun bytesForMillis(millis: Int): Int = (sampleRate * bytesPerFrame * millis / 1000)

    fun millisForBytes(bytes: Int): Int =
        if (bytesPerFrame == 0 || sampleRate == 0) 0 else (bytes * 1000 / (sampleRate * bytesPerFrame))
}

/** 一帧 PCM16 音频。 */
class AudioFrame(
    val pcm16: ByteArray,
    val timestampMillis: Long,
    val source: AudioSourceType,
)

/** 某个音频源在当前设备 / 当前平台是否可用。 */
data class CaptureSupport(
    val supported: Boolean,
    val reason: String? = null,
)

/** 平台音频采集后端。 */
interface AudioCaptureBackend {
    val source: AudioSourceType

    fun isSupported(): CaptureSupport

    /** 开始采集；实现方需在独立线程 / 协程中持续回调 [onFrame]。 */
    suspend fun start(format: AudioFormatSpec, onFrame: (AudioFrame) -> Unit)

    suspend fun stop()
}

/** 由各平台提供具体实现。 */
expect fun createAudioCaptureBackend(source: AudioSourceType): AudioCaptureBackend
