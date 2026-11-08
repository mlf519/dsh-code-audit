package com.interviewcopilot.core.settings

import android.content.Context
import com.interviewcopilot.core.util.AppLog
import com.interviewcopilot.platform.AndroidAppContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class AndroidSettingsStore : SettingsStore {

    private val prefs by lazy {
        AndroidAppContext.require().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    override suspend fun load(): AppSettings = withContext(Dispatchers.IO) {
        val raw = prefs.getString(KEY_SETTINGS, null) ?: return@withContext AppSettings()
        runCatching { SettingsJson.decodeFromString(AppSettings.serializer(), raw) }
            .onFailure { AppLog.e(TAG, "解析设置失败，使用默认值", it) }
            .getOrElse { AppSettings() }
    }

    override suspend fun save(settings: AppSettings) {
        withContext(Dispatchers.IO) {
            runCatching {
                prefs.edit()
                    .putString(KEY_SETTINGS, SettingsJson.encodeToString(AppSettings.serializer(), settings))
                    .apply()
            }.onFailure { AppLog.e(TAG, "保存设置失败", it) }
        }
    }

    private companion object {
        const val PREFS_NAME = "interview_copilot"
        const val KEY_SETTINGS = "settings"
        const val TAG = "AndroidSettings"
    }
}

actual fun createSettingsStore(): SettingsStore = AndroidSettingsStore()
