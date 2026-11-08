package com.interviewcopilot.core.util

/** 当前时间戳（毫秒）。Android / JVM 各自实现。 */
expect fun nowMillis(): Long

/** 运行平台名称，用于界面展示与能力探测提示。 */
expect fun platformName(): String

object AppLog {
    var enabled: Boolean = true

    fun d(tag: String, message: String) {
        if (enabled) println("[$tag] $message")
    }

    fun e(tag: String, message: String, cause: Throwable? = null) {
        if (!enabled) return
        println("[$tag] ERROR $message")
        cause?.printStackTrace()
    }
}
