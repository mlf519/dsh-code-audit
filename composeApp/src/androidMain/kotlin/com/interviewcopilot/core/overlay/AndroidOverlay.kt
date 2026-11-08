package com.interviewcopilot.core.overlay

import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.interviewcopilot.platform.AndroidAppContext
import com.interviewcopilot.service.OverlayService

/** Android 用 SYSTEM_ALERT_WINDOW 前台服务把最新回答浮在会议 App 之上。 */
private class AndroidOverlayPresenter : OverlayPresenter {

    override val supported: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            Settings.canDrawOverlays(AndroidAppContext.require())

    override fun show() {
        if (!supported) return
        val context = AndroidAppContext.require()
        val intent = Intent(context, OverlayService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    override fun hide() {
        val context = AndroidAppContext.require()
        context.stopService(Intent(context, OverlayService::class.java))
    }
}

actual fun createOverlayPresenter(): OverlayPresenter = AndroidOverlayPresenter()
