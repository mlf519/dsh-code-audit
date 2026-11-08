package com.interviewcopilot.core.overlay

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** 浮层内容：始终镜像“最新一条回答”，供各平台的悬浮窗渲染。 */
data class OverlayContent(
    val question: String = "",
    val answer: String = "",
    val visible: Boolean = false,
)

/**
 * 回答浮层的共享状态。
 * Android 的前台服务与 Compose 界面都从这个单例取内容，避免服务与界面互相持有引用。
 */
object OverlayState {
    private val _value = MutableStateFlow(OverlayContent())
    val value: StateFlow<OverlayContent> = _value.asStateFlow()

    fun show(question: String, answer: String) {
        _value.value = OverlayContent(question, answer, visible = true)
    }

    fun hide() {
        _value.update { it.copy(visible = false) }
    }

    fun clear() {
        _value.value = OverlayContent()
    }
}

/**
 * 悬浮层开关。
 * Android：SYSTEM_ALERT_WINDOW 前台服务（覆盖在会议 App 之上）；
 * Windows：由主窗口自身的置顶能力承担，所以这里是空实现。
 */
interface OverlayPresenter {
    val supported: Boolean
    fun show()
    fun hide()
}

expect fun createOverlayPresenter(): OverlayPresenter
