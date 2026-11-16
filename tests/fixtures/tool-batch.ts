/** Keep provider-data fixtures independent of the native batch transport envelope. */
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ActivityTools } from '../../src/sources/activity-types.ts'

export function asToolBatch(dispatch: (request: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>): ActivityTools['execute'] {
  return async ({ calls }) => ({ results: await Promise.all(calls.map(async call => ({ callId: call.id,
    result: await dispatch({ name: call.name, arguments: JSON.parse(call.arguments) }) as ToolExecutionResult }))),
    additionalContexts: [], concluded: false })
}
