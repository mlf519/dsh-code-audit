package com.interviewcopilot.core.util

actual fun nowMillis(): Long = System.currentTimeMillis()

actual fun platformName(): String {
    val os = System.getProperty("os.name").orEmpty()
    val label = when {
        os.contains("Windows", ignoreCase = true) -> "Windows"
        os.contains("Mac", ignoreCase = true) -> "macOS"
        os.contains("Linux", ignoreCase = true) -> "Linux"
        os.isBlank() -> "Desktop"
        else -> os
    }
    return "$label · JVM ${System.getProperty("java.version")}"
}
