package com.interviewcopilot.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.interviewcopilot.core.model.AudioSourceType
import com.interviewcopilot.core.model.LlmProviderKind
import com.interviewcopilot.core.model.PipelineMode
import com.interviewcopilot.core.model.RealtimeProviderKind
import com.interviewcopilot.core.settings.AppSettings

@Composable
fun SettingsScreen(
    settings: AppSettings,
    onBack: () -> Unit,
    onRefreshCapabilities: () -> Unit,
    onUpdate: ((AppSettings) -> AppSettings) -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
            }
            Text("设置", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Section("处理链路") {
                settings.mode.let { current ->
                    PipelineMode.entries.forEach { mode ->
                        OptionRow(
                            title = mode.label,
                            subtitle = mode.hint,
                            selected = current == mode,
                            onSelect = { onUpdate { it.copy(mode = mode) } },
                        )
                    }
                }
                Text(
                    text = "链路 A：音频先转写成文字再交给文本大模型；链路 B：音频直接推给原生语音大模型，省掉一次往返。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Section("声音来源", trailing = {
                IconButton(onClick = onRefreshCapabilities) {
                    Icon(Icons.Filled.Refresh, contentDescription = "重新探测能力")
                }
            }) {
                AudioSourceType.entries.forEach { source ->
                    OptionRow(
                        title = source.label,
                        subtitle = source.hint,
                        selected = settings.audioSource == source,
                        onSelect = { onUpdate { it.copy(audioSource = source) } },
                    )
                }
                NumberField(
                    label = "采集采样率 (Hz)",
                    value = settings.sampleRate.toString(),
                    onValueChange = { text -> text.toIntOrNull()?.let { rate -> onUpdate { it.copy(sampleRate = rate) } } },
                )
            }

            Section("文本大模型（链路 A）") {
                LlmProviderKind.entries.forEach { kind ->
                    OptionRow(
                        title = kind.label,
                        subtitle = null,
                        selected = settings.llm.kind == kind,
                        onSelect = { onUpdate { it.copy(llm = it.llm.copy(kind = kind)) } },
                    )
                }
                TextField(
                    label = "Base URL",
                    value = settings.llm.baseUrl,
                    onValueChange = { value -> onUpdate { it.copy(llm = it.llm.copy(baseUrl = value)) } },
                )
                TextField(
                    label = "API Key",
                    value = settings.llm.apiKey,
                    onValueChange = { value -> onUpdate { it.copy(llm = it.llm.copy(apiKey = value)) } },
                )
                TextField(
                    label = "模型",
                    value = settings.llm.model,
                    onValueChange = { value -> onUpdate { it.copy(llm = it.llm.copy(model = value)) } },
                )
                NumberField(
                    label = "最大输出 Token",
                    value = settings.llm.maxTokens.toString(),
                    onValueChange = { text ->
                        text.toIntOrNull()?.let { tokens -> onUpdate { it.copy(llm = it.llm.copy(maxTokens = tokens)) } }
                    },
                )
            }

            Section("语音转写 ASR（链路 A）") {
                TextField(
                    label = "Base URL",
                    value = settings.asr.baseUrl,
                    onValueChange = { value -> onUpdate { it.copy(asr = it.asr.copy(baseUrl = value)) } },
                )
                TextField(
                    label = "API Key",
                    value = settings.asr.apiKey,
                    onValueChange = { value -> onUpdate { it.copy(asr = it.asr.copy(apiKey = value)) } },
                )
                TextField(
                    label = "模型",
                    value = settings.asr.model,
                    onValueChange = { value -> onUpdate { it.copy(asr = it.asr.copy(model = value)) } },
                )
                TextField(
                    label = "语言（如 zh / en）",
                    value = settings.asr.language,
                    onValueChange = { value -> onUpdate { it.copy(asr = it.asr.copy(language = value)) } },
                )
                TextField(
                    label = "识别提示词（可填专业术语）",
                    value = settings.asr.prompt,
                    onValueChange = { value -> onUpdate { it.copy(asr = it.asr.copy(prompt = value)) } },
                )
            }

            Section("原生语音大模型（链路 B）") {
                RealtimeProviderKind.entries.forEach { kind ->
                    OptionRow(
                        title = kind.label,
                        subtitle = null,
                        selected = settings.realtime.kind == kind,
                        onSelect = { onUpdate { it.copy(realtime = it.realtime.copy(kind = kind)) } },
                    )
                }
                TextField(
                    label = "WebSocket URL",
                    value = settings.realtime.url,
                    onValueChange = { value -> onUpdate { it.copy(realtime = it.realtime.copy(url = value)) } },
                )
                TextField(
                    label = "API Key",
                    value = settings.realtime.apiKey,
                    onValueChange = { value -> onUpdate { it.copy(realtime = it.realtime.copy(apiKey = value)) } },
                )
                TextField(
                    label = "模型",
                    value = settings.realtime.model,
                    onValueChange = { value -> onUpdate { it.copy(realtime = it.realtime.copy(model = value)) } },
                )
            }

            Section("显示") {
                SwitchRow(
                    title = "开启回答浮层",
                    subtitle = "Android：悬浮窗置顶；Windows：窗口置顶",
                    checked = settings.display.overlayEnabled,
                    onCheckedChange = { enabled -> onUpdate { it.copy(display = it.display.copy(overlayEnabled = enabled)) } },
                )
                SwitchRow(
                    title = "显示转写记录",
                    subtitle = null,
                    checked = settings.display.showTranscript,
                    onCheckedChange = { show -> onUpdate { it.copy(display = it.display.copy(showTranscript = show)) } },
                )
                NumberField(
                    label = "回答字号 (sp)",
                    value = settings.display.fontSizeSp.toString(),
                    onValueChange = { text ->
                        text.toIntOrNull()?.let { size -> onUpdate { it.copy(display = it.display.copy(fontSizeSp = size)) } }
                    },
                )
                NumberField(
                    label = "保留回答条数",
                    value = settings.display.keepAnswers.toString(),
                    onValueChange = { text ->
                        text.toIntOrNull()?.let { count -> onUpdate { it.copy(display = it.display.copy(keepAnswers = count)) } }
                    },
                )
            }

            Section("语音分段（VAD）") {
                NumberField(
                    label = "断句静音阈值 (ms)",
                    value = settings.vad.endSilenceMillis.toString(),
                    onValueChange = { text ->
                        text.toIntOrNull()?.let { value -> onUpdate { it.copy(vad = it.vad.copy(endSilenceMillis = value)) } }
                    },
                )
                NumberField(
                    label = "最短语音时长 (ms)",
                    value = settings.vad.minSpeechMillis.toString(),
                    onValueChange = { text ->
                        text.toIntOrNull()?.let { value -> onUpdate { it.copy(vad = it.vad.copy(minSpeechMillis = value)) } }
                    },
                )
                TextField(
                    label = "系统提示词",
                    value = settings.systemPrompt,
                    singleLine = false,
                    minLines = 4,
                    onValueChange = { value -> onUpdate { it.copy(systemPrompt = value) } },
                )
            }

            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun Section(
    title: String,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                trailing?.invoke()
            }
            content()
        }
    }
}

@Composable
private fun OptionRow(title: String, subtitle: String?, selected: Boolean, onSelect: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, onClick = onSelect),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Column(modifier = Modifier.padding(start = 4.dp)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            subtitle?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SwitchRow(title: String, subtitle: String?, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            subtitle?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun TextField(
    label: String,
    value: String,
    singleLine: Boolean = true,
    minLines: Int = 1,
    onValueChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = singleLine,
        minLines = minLines,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun NumberField(label: String, value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = Modifier.fillMaxWidth(),
    )
}
