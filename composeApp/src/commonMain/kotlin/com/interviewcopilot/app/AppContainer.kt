package com.interviewcopilot.app

import com.interviewcopilot.core.asr.AsrEngine
import com.interviewcopilot.core.asr.OpenAiCompatibleAsrEngine
import com.interviewcopilot.core.audio.AudioCaptureManager
import com.interviewcopilot.core.network.UnifiedLlmClient
import com.interviewcopilot.core.network.buildHttpClient
import com.interviewcopilot.core.overlay.OverlayPresenter
import com.interviewcopilot.core.overlay.createOverlayPresenter
import com.interviewcopilot.core.settings.SettingsStore
import com.interviewcopilot.core.settings.createSettingsStore
import com.interviewcopilot.feature.session.InterviewSessionController
import io.ktor.client.HttpClient
import kotlinx.coroutines.CoroutineScope

/**
 * 手写依赖容器（对应 Hanako 的 AppContainer）：
 * 显式装配，不引第三方 DI 框架，方便阅读与调试。
 */
class AppContainer(
    private val scope: CoroutineScope,
) {
    val http: HttpClient = buildHttpClient()

    val settingsStore: SettingsStore = createSettingsStore()

    val audioCapture: AudioCaptureManager = AudioCaptureManager()

    val llmClient: UnifiedLlmClient = UnifiedLlmClient(http)

    val asrEngine: AsrEngine = OpenAiCompatibleAsrEngine(http)

    val overlay: OverlayPresenter = createOverlayPresenter()

    val sessionController: InterviewSessionController = InterviewSessionController(
        settingsStore = settingsStore,
        audioCapture = audioCapture,
        llmClient = llmClient,
        asrEngine = asrEngine,
        http = http,
        overlay = overlay,
        scope = scope,
    )
}
