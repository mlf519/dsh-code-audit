package com.interviewcopilot

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.interviewcopilot.app.App
import com.interviewcopilot.core.audio.AndroidMediaProjectionHolder
import com.interviewcopilot.core.model.AudioSourceType
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val container get() = (application as InterviewCopilotApp).container

    /** 同一个授权只弹一次，避免用户反复被系统框打断。 */
    private var projectionRequested = false

    private val audioPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            container.sessionController.refreshCapabilities()
        }

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            if (result.resultCode == RESULT_OK && data != null) {
                val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                AndroidMediaProjectionHolder.projection = manager.getMediaProjection(result.resultCode, data)
            }
            container.sessionController.refreshCapabilities()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ensureAudioPermission()
        ensureOverlayPermission()
        requestProjectionWhenNeeded()

        setContent { App(container) }
    }

    override fun onResume() {
        super.onResume()
        // 从系统设置页返回后，悬浮窗权限可能刚被授予，重新探测一次。
        container.sessionController.refreshCapabilities()
    }

    private fun ensureAudioPermission() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    private fun ensureOverlayPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            startActivity(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")),
            )
        }
    }

    /** 选了「系统输出」才需要 MediaProjection，其它音源不打扰用户。 */
    private fun requestProjectionWhenNeeded() {
        lifecycleScope.launch {
            container.sessionController.settings.collect { settings ->
                val needProjection = settings.audioSource == AudioSourceType.SYSTEM_OUTPUT
                if (needProjection && AndroidMediaProjectionHolder.projection == null && !projectionRequested) {
                    projectionRequested = true
                    val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                    projectionLauncher.launch(manager.createScreenCaptureIntent())
                }
            }
        }
    }
}
