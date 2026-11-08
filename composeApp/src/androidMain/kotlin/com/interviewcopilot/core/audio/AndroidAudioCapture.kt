package com.interviewcopilot.core.audio

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat as AndroidAudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.os.Build
import androidx.core.content.ContextCompat
import com.interviewcopilot.core.model.AudioSourceType
import com.interviewcopilot.core.util.AppLog
import com.interviewcopilot.platform.AndroidAppContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext

/**
 * MainActivity 拿到 MediaProjection 授权后放进来，供「系统输出」采集使用。
 * 抽成独立单例是为了让采集后端不依赖 Activity。
 */
object AndroidMediaProjectionHolder {
    @Volatile
    var projection: MediaProjection? = null
}

actual fun createAudioCaptureBackend(source: AudioSourceType): AudioCaptureBackend = when (source) {
    AudioSourceType.MIC -> AndroidMicCaptureBackend()

    AudioSourceType.SYSTEM_OUTPUT -> AndroidPlaybackCaptureBackend()

    AudioSourceType.CALL -> AndroidUnsupportedCaptureBackend(
        source,
        "通话音频需要 VOICE_CALL 权限，只有系统签名 / 特权应用才能申请；普通应用请改用「系统输出」并在通话时开启免提",
    )
}

private fun hasRecordPermission(): Boolean =
    ContextCompat.checkSelfPermission(
        AndroidAppContext.require(),
        Manifest.permission.RECORD_AUDIO,
    ) == PackageManager.PERMISSION_GRANTED

/** AudioRecord 通用读取循环，必要时把设备实际采样率重采样到目标格式。 */
private suspend fun pump(
    record: AudioRecord,
    format: AudioFormatSpec,
    source: AudioSourceType,
    onFrame: (AudioFrame) -> Unit,
) {
    val actualRate = record.sampleRate
    withContext(Dispatchers.IO) {
        val buffer = ByteArray(format.bytesForMillis(CHUNK_MILLIS))
        val startedAt = System.currentTimeMillis()
        while (currentCoroutineContext().isActive) {
            val read = record.read(buffer, 0, buffer.size)
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

private const val CHUNK_MILLIS = 100

/** 麦克风：AudioRecord + VOICE_RECOGNITION，自带降噪，适合采集本方发言。 */
private class AndroidMicCaptureBackend : AudioCaptureBackend {

    override val source: AudioSourceType = AudioSourceType.MIC

    private var record: AudioRecord? = null

    override fun isSupported(): CaptureSupport =
        if (hasRecordPermission()) {
            CaptureSupport(true)
        } else {
            CaptureSupport(false, "缺少录音权限，请在系统设置里授予麦克风权限")
        }

    override suspend fun start(format: AudioFormatSpec, onFrame: (AudioFrame) -> Unit) {
        val minBuffer = AudioRecord.getMinBufferSize(
            format.sampleRate,
            AndroidAudioFormat.CHANNEL_IN_MONO,
            AndroidAudioFormat.ENCODING_PCM_16BIT,
        )
        check(minBuffer > 0) { "设备不支持 ${format.sampleRate}Hz 录音" }
        val created = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            format.sampleRate,
            AndroidAudioFormat.CHANNEL_IN_MONO,
            AndroidAudioFormat.ENCODING_PCM_16BIT,
            maxOf(minBuffer, format.bytesForMillis(200)),
        )
        check(created.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord 初始化失败" }
        record = created
        created.startRecording()
        AppLog.d(TAG, "mic capture started actualRate=${created.sampleRate}")
        try {
            pump(created, format, source, onFrame)
        } finally {
            // 取消路径上不能再调用挂起函数，这里直接释放。
            record = null
            runCatching { created.stop() }
            runCatching { created.release() }
        }
    }

    override suspend fun stop() {
        val current = record ?: return
        record = null
        withContext(Dispatchers.IO) {
            runCatching { current.stop() }
            runCatching { current.release() }
        }
    }

    private companion object {
        const val TAG = "AndroidMicCapture"
    }
}

/** 系统输出：AudioPlaybackCapture（Android 10+），需要 MediaProjection 授权。 */
private class AndroidPlaybackCaptureBackend : AudioCaptureBackend {

    override val source: AudioSourceType = AudioSourceType.SYSTEM_OUTPUT

    private var record: AudioRecord? = null

    override fun isSupported(): CaptureSupport = when {
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ->
            CaptureSupport(false, "系统输出采集需要 Android 10（API 29）及以上")

        AndroidMediaProjectionHolder.projection == null ->
            CaptureSupport(false, "尚未获得音频捕获授权，开始监听时会弹出系统授权框")

        else -> CaptureSupport(true)
    }

    override suspend fun start(format: AudioFormatSpec, onFrame: (AudioFrame) -> Unit) {
        val projection = AndroidMediaProjectionHolder.projection
            ?: error("缺少 MediaProjection 授权")
        val config = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(android.media.AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .addMatchingUsage(android.media.AudioAttributes.USAGE_UNKNOWN)
            .build()
        val minBuffer = AudioRecord.getMinBufferSize(
            format.sampleRate,
            AndroidAudioFormat.CHANNEL_IN_MONO,
            AndroidAudioFormat.ENCODING_PCM_16BIT,
        )
        check(minBuffer > 0) { "设备不支持 ${format.sampleRate}Hz 采集" }
        val created = AudioRecord.Builder()
            .setAudioFormat(
                AndroidAudioFormat.Builder()
                    .setEncoding(AndroidAudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(format.sampleRate)
                    .setChannelMask(AndroidAudioFormat.CHANNEL_IN_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(maxOf(minBuffer, format.bytesForMillis(200)))
            .setAudioPlaybackCaptureConfig(config)
            .build()
        check(created.state == AudioRecord.STATE_INITIALIZED) { "AudioPlaybackCapture 初始化失败" }
        record = created
        created.startRecording()
        AppLog.d(TAG, "playback capture started actualRate=${created.sampleRate}")
        try {
            pump(created, format, source, onFrame)
        } finally {
            record = null
            runCatching { created.stop() }
            runCatching { created.release() }
        }
    }

    override suspend fun stop() {
        val current = record ?: return
        record = null
        withContext(Dispatchers.IO) {
            runCatching { current.stop() }
            runCatching { current.release() }
        }
    }

    private companion object {
        const val TAG = "AndroidPlaybackCapture"
    }
}

private class AndroidUnsupportedCaptureBackend(
    override val source: AudioSourceType,
    private val reason: String,
) : AudioCaptureBackend {
    override fun isSupported(): CaptureSupport = CaptureSupport(false, reason)
    override suspend fun start(format: AudioFormatSpec, onFrame: (AudioFrame) -> Unit) = error(reason)
    override suspend fun stop() = Unit
}
