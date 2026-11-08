package com.interviewcopilot.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.Build
import android.os.IBinder
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import com.interviewcopilot.core.audio.AndroidMediaProjectionHolder
import com.interviewcopilot.core.overlay.OverlayContent
import com.interviewcopilot.core.overlay.OverlayState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * 回答浮层：前台服务 + TYPE_APPLICATION_OVERLAY 的 TextView，把 [OverlayState] 里的最新回答画在会议 App 之上。
 */
class OverlayService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var windowManager: WindowManager? = null
    private var overlayView: TextView? = null
    private var collectJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForegroundCompat()
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        collectJob = scope.launch {
            OverlayState.value.collectLatest(::render)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        collectJob?.cancel()
        removeOverlay()
        scope.cancel()
        super.onDestroy()
    }

    private fun render(content: OverlayContent) {
        if (!content.visible || content.answer.isBlank()) {
            removeOverlay()
            return
        }
        val view = overlayView ?: createOverlay()
        view.text = buildString {
            if (content.question.isNotBlank()) {
                append("Q：").append(content.question).append("\n\n")
            }
            append(content.answer)
        }
    }

    private fun createOverlay(): TextView {
        val view = TextView(this).apply {
            setTextColor(0xFFE6E9F2.toInt())
            textSize = 13f
            setPadding(28, 20, 28, 20)
            setBackgroundColor(0xE6101A2E.toInt())
            maxLines = 12
        }
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 24
            y = 240
        }
        runCatching { windowManager?.addView(view, params) }
        overlayView = view
        return view
    }

    private fun removeOverlay() {
        val view = overlayView ?: return
        overlayView = null
        runCatching { windowManager?.removeView(view) }
    }

    private fun startForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "回答浮层", NotificationManager.IMPORTANCE_LOW),
                )
            }
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle("Interview Copilot")
            .setContentText("正在监听并生成回答")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()

        val types = foregroundServiceTypes()
        if (types != 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, types)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /**
     * Android 14 起前台服务必须声明类型。浮层用 specialUse；
     * 如果此时已经拿到投影授权（系统输出采集要用），再叠加 mediaProjection 类型。
     */
    private fun foregroundServiceTypes(): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
        var types = 0
        if (Build.VERSION.SDK_INT >= 34) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        }
        if (AndroidMediaProjectionHolder.projection != null) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        }
        return types
    }

    private companion object {
        const val CHANNEL_ID = "interview_copilot_overlay"
        const val NOTIFICATION_ID = 1024
    }
}
