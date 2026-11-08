package com.interviewcopilot.core.util

import android.os.Build

actual fun nowMillis(): Long = System.currentTimeMillis()

actual fun platformName(): String = "Android ${Build.VERSION.RELEASE}（API ${Build.VERSION.SDK_INT}）"
