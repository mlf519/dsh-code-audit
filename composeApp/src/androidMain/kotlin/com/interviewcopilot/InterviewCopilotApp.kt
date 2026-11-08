package com.interviewcopilot

import android.app.Application
import com.interviewcopilot.app.AppContainer
import com.interviewcopilot.platform.AndroidAppContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** 进程级单例：界面与悬浮窗服务共用同一个 AppContainer。 */
class InterviewCopilotApp : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        AndroidAppContext.init(this)
        container = AppContainer(CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate))
    }
}
