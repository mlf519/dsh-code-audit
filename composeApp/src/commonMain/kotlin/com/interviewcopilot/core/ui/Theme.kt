package com.interviewcopilot.core.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val InterviewDarkColors = darkColorScheme(
    primary = Color(0xFF7C93FF),
    onPrimary = Color(0xFF0A1024),
    primaryContainer = Color(0xFF232F58),
    onPrimaryContainer = Color(0xFFDAE1FF),
    secondary = Color(0xFF4FD1C5),
    onSecondary = Color(0xFF04241F),
    background = Color(0xFF0A0F1E),
    onBackground = Color(0xFFE6E9F2),
    surface = Color(0xFF131A2E),
    onSurface = Color(0xFFE6E9F2),
    surfaceVariant = Color(0xFF1D2642),
    onSurfaceVariant = Color(0xFFA9B1C9),
    outline = Color(0xFF39436A),
    error = Color(0xFFFF7B7B),
    onError = Color(0xFF2A0808),
)

/** 深色单一主题：面试场景多在会议 / 通话界面旁边常驻，深色底更不刺眼。 */
@Composable
fun InterviewCopilotTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = InterviewDarkColors, content = content)
}
