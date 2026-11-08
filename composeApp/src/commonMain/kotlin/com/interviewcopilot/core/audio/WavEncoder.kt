package com.interviewcopilot.core.audio

/** 把 PCM16 裸流封成 WAV，供 ASR 的 multipart 上传使用。 */
object WavEncoder {

    fun toWav(pcm16: ByteArray, format: AudioFormatSpec): ByteArray {
        val dataSize = pcm16.size
        val byteRate = format.sampleRate * format.channels * format.bitsPerSample / 8
        val blockAlign = format.channels * format.bitsPerSample / 8

        val header = ByteArray(44)
        var p = 0
        fun writeAscii(value: String) {
            value.forEach { header[p++] = it.code.toByte() }
        }

        fun writeInt(value: Int) {
            header[p++] = (value and 0xFF).toByte()
            header[p++] = ((value shr 8) and 0xFF).toByte()
            header[p++] = ((value shr 16) and 0xFF).toByte()
            header[p++] = ((value shr 24) and 0xFF).toByte()
        }

        fun writeShort(value: Int) {
            header[p++] = (value and 0xFF).toByte()
            header[p++] = ((value shr 8) and 0xFF).toByte()
        }

        writeAscii("RIFF")
        writeInt(36 + dataSize)
        writeAscii("WAVE")
        writeAscii("fmt ")
        writeInt(16)
        writeShort(1) // PCM
        writeShort(format.channels)
        writeInt(format.sampleRate)
        writeInt(byteRate)
        writeShort(blockAlign)
        writeShort(format.bitsPerSample)
        writeAscii("data")
        writeInt(dataSize)

        return header + pcm16
    }
}
