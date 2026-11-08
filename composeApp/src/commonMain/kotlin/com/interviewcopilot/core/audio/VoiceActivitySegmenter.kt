package com.interviewcopilot.core.audio

import kotlinx.serialization.Serializable
import kotlin.math.sqrt

@Serializable
data class VadConfig(
    /** 判定为“有人说话”的能量阈值（归一化 RMS，0~1）。 */
    val rmsThreshold: Float = 0.015f,
    /** 一段语音至少要持续这么久才送 ASR，避免把咳嗽、翻页声送去转写。 */
    val minSpeechMillis: Int = 400,
    /** 连续静音这么久就认为一句话结束，触发切分。 */
    val endSilenceMillis: Int = 700,
    /** 单段最长时长，超过则强制切分，避免长回答攒成超长音频。 */
    val maxSegmentMillis: Int = 15_000,
    /** 触发前的预滚缓冲，避免吞掉句首的字。 */
    val preRollMillis: Int = 250,
)

sealed interface VadEvent {
    data class SpeechStarted(val atMillis: Long) : VadEvent

    data class SegmentReady(val pcm16: ByteArray, val durationMillis: Int) : VadEvent

    data class SegmentDropped(val durationMillis: Int, val reason: String) : VadEvent
}

/**
 * 基于能量阈值的轻量 VAD + 分段器（对应 Hanako 里“把一次截屏切成一题”的那步）。
 * 不引入模型依赖，三端行为一致；需要更准时可整体替换为 Silero VAD。
 */
class VoiceActivitySegmenter(
    private val config: VadConfig,
    private val format: AudioFormatSpec,
) {
    private val bytesPerMillis: Double =
        (format.sampleRate * format.bytesPerFrame).toDouble() / 1000.0

    private val preRoll = ArrayDeque<ByteArray>()
    private var preRollBytes = 0

    private val segment = ArrayList<ByteArray>()
    private var segmentBytes = 0

    private var inSpeech = false
    private var speechMillis = 0
    private var silenceMillis = 0

    var currentLevel: Float = 0f
        private set

    fun reset() {
        preRoll.clear()
        preRollBytes = 0
        segment.clear()
        segmentBytes = 0
        inSpeech = false
        speechMillis = 0
        silenceMillis = 0
    }

    fun accept(frame: AudioFrame): VadEvent? {
        val rms = rms(frame.pcm16)
        currentLevel = rms
        val frameMillis = format.millisForBytes(frame.pcm16.size)
        val speaking = rms >= config.rmsThreshold

        if (!inSpeech) {
            pushPreRoll(frame.pcm16)
            if (!speaking) return null

            inSpeech = true
            speechMillis = frameMillis
            silenceMillis = 0
            segment.clear()
            segmentBytes = 0
            preRoll.forEach {
                segment.add(it)
                segmentBytes += it.size
            }
            preRoll.clear()
            preRollBytes = 0
            return VadEvent.SpeechStarted(frame.timestampMillis)
        }

        segment.add(frame.pcm16)
        segmentBytes += frame.pcm16.size
        if (speaking) {
            speechMillis += frameMillis
            silenceMillis = 0
        } else {
            silenceMillis += frameMillis
        }

        val durationMillis = format.millisForBytes(segmentBytes)

        if (silenceMillis >= config.endSilenceMillis) {
            val pcm = concat(segment, segmentBytes)
            val speech = speechMillis
            inSpeech = false
            segment.clear()
            segmentBytes = 0
            speechMillis = 0
            silenceMillis = 0
            return if (speech >= config.minSpeechMillis) {
                VadEvent.SegmentReady(pcm, durationMillis)
            } else {
                VadEvent.SegmentDropped(durationMillis, "有效语音过短")
            }
        }

        if (durationMillis >= config.maxSegmentMillis) {
            val pcm = concat(segment, segmentBytes)
            segment.clear()
            segmentBytes = 0
            speechMillis = frameMillis
            return VadEvent.SegmentReady(pcm, durationMillis)
        }

        return null
    }

    private fun pushPreRoll(bytes: ByteArray) {
        if (config.preRollMillis <= 0) return
        val copy = bytes.copyOf()
        preRoll.addLast(copy)
        preRollBytes += copy.size
        val limit = format.bytesForMillis(config.preRollMillis)
        while (preRollBytes > limit && preRoll.size > 1) {
            preRollBytes -= preRoll.removeFirst().size
        }
    }

    private fun concat(chunks: List<ByteArray>, total: Int): ByteArray {
        val out = ByteArray(total)
        var offset = 0
        chunks.forEach {
            it.copyInto(out, offset)
            offset += it.size
        }
        return out
    }

    private fun rms(pcm16: ByteArray): Float {
        if (pcm16.size < 2) return 0f
        var sum = 0.0
        var i = 0
        while (i + 1 < pcm16.size) {
            val lo = pcm16[i].toInt() and 0xFF
            val hi = pcm16[i + 1].toInt()
            val sample = ((hi shl 8) or lo).toShort().toInt() / 32768.0
            sum += sample * sample
            i += 2
        }
        val count = pcm16.size / 2
        if (count == 0) return 0f
        return sqrt(sum / count).toFloat()
    }
}
