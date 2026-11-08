package com.interviewcopilot.core.overlay

/**
 * Windows 端由主窗口的 alwaysOnTop 承担浮层职责，这里不需要额外窗口。
 */
private class DesktopOverlayPresenter : OverlayPresenter {
    override val supported: Boolean = false
    override fun show() = Unit
    override fun hide() = Unit
}

actual fun createOverlayPresenter(): OverlayPresenter = DesktopOverlayPresenter()
