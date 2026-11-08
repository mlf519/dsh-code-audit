package com.interviewcopilot.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.interviewcopilot.core.ui.InterviewCopilotTheme
import com.interviewcopilot.feature.session.SessionScreen
import com.interviewcopilot.feature.settings.SettingsScreen

/** 两个页面：会话主界面与设置页。用最简单的内存状态做切换，不引导航库。 */
private enum class Screen { SESSION, SETTINGS }

@Composable
fun App(container: AppContainer) {
    val controller = container.sessionController
    val state by controller.state.collectAsState()
    val settings by controller.settings.collectAsState()

    var screen by remember { mutableStateOf(Screen.SESSION) }

    InterviewCopilotTheme {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background),
        ) {
            when (screen) {
                Screen.SESSION -> SessionScreen(
                    state = state,
                    settings = settings,
                    onStart = controller::start,
                    onStop = controller::stop,
                    onOpenSettings = { screen = Screen.SETTINGS },
                    onDismissError = controller::dismissError,
                )

                Screen.SETTINGS -> SettingsScreen(
                    settings = settings,
                    onBack = { screen = Screen.SESSION },
                    onRefreshCapabilities = controller::refreshCapabilities,
                    onUpdate = controller::updateSettings,
                )
            }
        }
    }
}
