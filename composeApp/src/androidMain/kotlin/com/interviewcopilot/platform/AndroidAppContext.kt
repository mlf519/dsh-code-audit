package com.interviewcopilot.platform

import android.content.Context

/**
 * Android 侧的平台上下文。设置存储与悬浮窗都从 Application 进程级的 Context 取，
 * 避免把 Activity 引用泄漏进 commonMain 的容器里。
 */
object AndroidAppContext {
    private var appContext: Context? = null

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    fun require(): Context = appContext ?: error("AndroidAppContext 尚未初始化")
}
