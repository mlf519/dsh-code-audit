package com.interviewcopilot

import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import com.interviewcopilot.app.App
import com.interviewcopilot.app.AppContainer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

fun main() = application {
    val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.Default) }
    val container = remember { AppContainer(scope) }
    val settings by container.sessionController.settings.collectAsState()

    Window(
        onCloseRequest = {
            container.sessionController.stop()
            scope.cancel()
            exitApplication()
        },
        title = "Interview Copilot",
        state = rememberWindowState(width = 1120.dp, height = 780.dp),
        // Windows 上「浮层」由窗口自身置顶承担，对应 Hanako 里截屏浮层的位置。
        alwaysOnTop = settings.display.overlayEnabled,
    ) {
        App(container)
    }
}
