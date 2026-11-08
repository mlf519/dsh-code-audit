package com.interviewcopilot.core.audio

import com.interviewcopilot.core.model.AudioSourceType
import com.interviewcopilot.core.util.AppLog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import javax.sound.sampled.AudioFormat
import javax.sound.sampled.AudioSystem
import javax.sound.sampled.DataLine
import javax.sound.sampled.Mixer
import javax.sound.sampled.TargetDataLine

actual fun createAudioCaptureBackend(source: AudioSourceType): AudioCaptureBackend = when (source) {
    AudioSourceType.MIC -> DesktopMicCaptureBackend()

    AudioSourceType.SYSTEM_OUTPUT -> DesktopLoopbackCaptureBackend()

    AudioSourceType.CALL -> DesktopUnsupportedCaptureBackend(
        source,
        "桌面端无法直接抓取通话音频：请在手机上使用 Android 版，或把通话声音外放后用麦克风采集",
    )
}

private fun toAudioFormat(format: AudioFormatSpec): AudioFormat =
    AudioFormat(format.sampleRate.toFloat(), format.bitsPerSample, format.channels, true, false)

/** 采集线路：mixer 为 null 表示用系统默认设备。 */
private class CaptureLine(val mixer: Mixer?, val info: DataLine.Info)

private abstract class DesktopCaptureBackend(
    override val source: AudioSourceType,
) : AudioCaptureBackend {

    private var line: TargetDataLine? = null

    /** 定位可用采集线路；找不到时抛异常，[isSupported] 会把异常信息转成「不可用原因」。 */
    protected abstract fun locate(format: AudioFormat): CaptureLine

    override fun isSupported(): CaptureSupport =
        runCatching { locate(toAudioFormat(AudioFormatSpec())) }
            .fold(
                onSuccess = { found ->
                    val ok = found.mixer?.isLineSupported(found.info) ?: AudioSystem.isLineSupported(found.info)
                    if (ok) {
                        CaptureSupport(true)
                    } else {
                        CaptureSupport(false, "${source.label}：设备存在，但不支持 16kHz 单声道 PCM 采集")
                    }
                },
                onFailure = { CaptureSupport(false, it.message ?: "${source.label} 当前不可用") },
            )

    override suspend fun start(format: AudioFormatSpec, onFrame: (AudioFrame) -> Unit) {
        val audioFormat = toAudioFormat(format)
        val found = locate(audioFormat)
        val opened = ((found.mixer?.getLine(found.info) ?: AudioSystem.getLine(found.info)) as TargetDataLine)
            .apply {
                open(audioFormat)
                start()
            }
        line = opened
        AppLog.d(TAG, "capture started source=${source.name} actualFormat=${opened.format}")

        val actualRate = opened.format.sampleRate.toInt()
        withContext(Dispatchers.IO) {
            val buffer = ByteArray(format.bytesForMillis(CHUNK_MILLIS))
            val startedAt = System.currentTimeMillis()
            while (currentCoroutineContext().isActive) {
                val read = opened.read(buffer, 0, buffer.size)
                if (read <= 0) continue
                val chunk = buffer.copyOf(read)
                val pcm = if (actualRate == format.sampleRate) {
                    chunk
                } else {
                    PcmResampler.resample(chunk, actualRate, format.sampleRate, format.channels)
                }
                onFrame(AudioFrame(pcm, System.currentTimeMillis() - startedAt, source))
            }
        }
    }

    override suspend fun stop() {
        withContext(Dispatchers.IO) {
            line?.let {
                runCatching { it.stop() }
                runCatching { it.close() }
            }
            line = null
        }
    }

    private companion object {
        const val TAG = "DesktopCapture"
        const val CHUNK_MILLIS = 100
    }
}

/** 麦克风：直接用系统默认输入设备。 */
private class DesktopMicCaptureBackend : DesktopCaptureBackend(AudioSourceType.MIC) {
    override fun locate(format: AudioFormat): CaptureLine {
        val info = DataLine.Info(TargetDataLine::class.java, format)
        check(AudioSystem.isLineSupported(info)) { "系统未找到可用的麦克风输入设备" }
        return CaptureLine(mixer = null, info = info)
    }
}

/**
 * 系统输出：javax.sound 拿不到 WASAPI Loopback，因此走「虚拟声卡 / 立体声混音」这条路 ——
 * 用户装一个 VB-Cable 之类的虚拟设备，把系统声音转发过去，这里再把它当普通输入设备采集。
 */
private class DesktopLoopbackCaptureBackend : DesktopCaptureBackend(AudioSourceType.SYSTEM_OUTPUT) {
    override fun locate(format: AudioFormat): CaptureLine {
        val info = DataLine.Info(TargetDataLine::class.java, format)
        val matched = AudioSystem.getMixerInfo().firstOrNull { descriptor ->
            val haystack = (descriptor.name + " " + descriptor.description).lowercase()
            LOOPBACK_HINTS.any { haystack.contains(it) }
        }
        checkNotNull(matched) {
            "未找到系统输出采集设备：请安装虚拟声卡（VB-Cable / VoiceMeeter）并让其成为系统的输出与输入，或在录音设备里启用“立体声混音”"
        }
        return CaptureLine(mixer = AudioSystem.getMixer(matched), info = info)
    }

    private companion object {
        val LOOPBACK_HINTS = listOf(
            "stereo mix",
            "loopback",
            "what u hear",
            "cable output",
            "vb-audio",
            "voicemeeter",
            "立体声混音",
        )
    }
}

private class DesktopUnsupportedCaptureBackend(
    override val source: AudioSourceType,
    private val reason: String,
) : AudioCaptureBackend {
    override fun isSupported(): CaptureSupport = CaptureSupport(false, reason)
    override suspend fun start(format: AudioFormatSpec, onFrame: (AudioFrame) -> Unit) = error(reason)
    override suspend fun stop() = Unit
}
