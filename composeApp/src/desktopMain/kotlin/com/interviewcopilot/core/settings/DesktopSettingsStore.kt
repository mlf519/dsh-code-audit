package com.interviewcopilot.core.settings

import com.interviewcopilot.core.util.AppLog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Windows 端把设置存到用户目录下的 JSON 文件，与 Android 的 SharedPreferences 语义一致。 */
class DesktopSettingsStore : SettingsStore {

    private val file = File(System.getProperty("user.home"), ".interviewcopilot/settings.json")

    override suspend fun load(): AppSettings = withContext(Dispatchers.IO) {
        if (!file.exists()) return@withContext AppSettings()
        runCatching { SettingsJson.decodeFromString(AppSettings.serializer(), file.readText()) }
            .onFailure { AppLog.e(TAG, "解析设置文件失败，使用默认值", it) }
            .getOrElse { AppSettings() }
    }

    override suspend fun save(settings: AppSettings) {
        withContext(Dispatchers.IO) {
            runCatching {
                file.parentFile?.mkdirs()
                file.writeText(SettingsJson.encodeToString(AppSettings.serializer(), settings))
            }.onFailure { AppLog.e(TAG, "写入设置文件失败", it) }
        }
    }

    private companion object {
        const val TAG = "DesktopSettings"
    }
}

actual fun createSettingsStore(): SettingsStore = DesktopSettingsStore()
