package com.interviewcopilot.core.workflow

import com.interviewcopilot.core.util.AppLog
import com.interviewcopilot.core.util.nowMillis
import kotlinx.coroutines.CancellationException

enum class NodeStatus { RUNNING, SUCCEEDED, FAILED, SKIPPED }

/** 每个节点执行前后落一条检查点，仅用于执行 + 记录（沿用 Hanako 的做法，不做恢复 / 重放）。 */
data class WorkflowCheckpoint(
    val workflowId: String,
    val nodeId: String,
    val nodeName: String,
    val status: NodeStatus,
    val atMillis: Long,
    val message: String? = null,
)

/** 节点之间传递数据：输入放进 [inputs]，中间产物写进 artifacts。 */
class WorkflowContext(
    val inputs: Map<String, Any?>,
) {
    private val artifacts = mutableMapOf<String, Any?>()

    fun put(key: String, value: Any?) {
        artifacts[key] = value
    }

    @Suppress("UNCHECKED_CAST")
    fun <T> get(key: String): T? = artifacts[key] as? T

    fun snapshot(): Map<String, Any?> = artifacts.toMap()
}

sealed interface NodeOutcome {
    /** 继续执行后续节点。 */
    data object Continue : NodeOutcome

    /** 正常终止（不是错误），例如转写为空时无需再问大模型。 */
    data class Stop(val reason: String) : NodeOutcome
}

interface WorkflowNode {
    val id: String
    val name: String

    suspend fun run(context: WorkflowContext): NodeOutcome
}

class Workflow(
    val id: String,
    val name: String,
    val nodes: List<WorkflowNode>,
)

data class WorkflowRunResult(
    val success: Boolean,
    val checkpoints: List<WorkflowCheckpoint>,
    val artifacts: Map<String, Any?>,
)

class WorkflowRunner(
    private val onCheckpoint: (WorkflowCheckpoint) -> Unit = {},
) {
    suspend fun run(
        workflow: Workflow,
        inputs: Map<String, Any?>,
        context: WorkflowContext = WorkflowContext(inputs),
    ): WorkflowRunResult {
        val checkpoints = mutableListOf<WorkflowCheckpoint>()
        var success = true

        fun record(node: WorkflowNode, status: NodeStatus, message: String?) {
            val checkpoint = WorkflowCheckpoint(
                workflowId = workflow.id,
                nodeId = node.id,
                nodeName = node.name,
                status = status,
                atMillis = nowMillis(),
                message = message,
            )
            checkpoints += checkpoint
            onCheckpoint(checkpoint)
        }

        for (node in workflow.nodes) {
            record(node, NodeStatus.RUNNING, null)
            val outcome = try {
                node.run(context)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (t: Throwable) {
                AppLog.e(TAG, "节点 ${node.id} 执行失败", t)
                record(node, NodeStatus.FAILED, t.message ?: t.toString())
                success = false
                break
            }
            when (outcome) {
                is NodeOutcome.Continue -> record(node, NodeStatus.SUCCEEDED, null)
                is NodeOutcome.Stop -> {
                    record(node, NodeStatus.SKIPPED, outcome.reason)
                    break
                }
            }
        }

        return WorkflowRunResult(success, checkpoints, context.snapshot())
    }

    private companion object {
        const val TAG = "WorkflowRunner"
    }
}
