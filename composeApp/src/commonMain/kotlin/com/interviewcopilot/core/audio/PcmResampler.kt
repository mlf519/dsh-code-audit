package com.interviewcopilot.core.audio

import kotlin.math.max
import kotlin.math.min

/**
 * 线性重采样（PCM16 单声道）。仅在采集格式与目标格式不一致时使用，
 * 例如 windows 采集到 44.1kHz，原生语音大模型需要 24kHz。
 */
object PcmResampler {

    fun resample(
        pcm16: ByteArray,
        fromRate: Int,
        toRate: Int,
        channels: Int,
    ): ByteArray {
        if (fromRate == toRate && channels == 1) return pcm16

        val samples = toSamples(pcm16, channels)
        if (samples.isEmpty()) return ByteArray(0)

        val ratio = toRate.toDouble() / fromRate.toDouble()
        val outCount = max(1, (samples.size * ratio).toInt())
        val out = ByteArray(outCount * 2)

        for (i in 0 until outCount) {
            val srcPos = i / ratio
            val i0 = min(samples.size - 1, srcPos.toInt())
            val i1 = min(samples.size - 1, i0 + 1)
            val frac = srcPos - i0
            val value = samples[i0] * (1 - frac) + samples[i1] * frac
            val s = value.toInt().coerceIn(-32768, 32767)
            out[i * 2] = (s and 0xFF).toByte()
            out[i * 2 + 1] = ((s shr 8) and 0xFF).toByte()
        }
        return out
    }

    private fun toSamples(pcm16: ByteArray, channels: Int): DoubleArray {
        val frames = pcm16.size / (2 * channels)
        val out = DoubleArray(frames)
        for (i in 0 until frames) {
            var sum = 0.0
            for (c in 0 until channels) {
                val offset = (i * channels + c) * 2
                val lo = pcm16[offset].toInt() and 0xFF
                val hi = pcm16[offset + 1].toInt()
                sum += ((hi shl 8) or lo).toShort().toInt()
            }
            out[i] = sum / channels
        }
        return out
    }
}
