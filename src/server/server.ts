import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import type {PartialJsonValue, UiResponse} from '@devvit/web/shared'
import {buildIndex, processThread, runCycle} from './jobs.ts'

type TaskRequest<T> = {data?: T}
type TaskResponse = {status: 'ok'}
type ErrorRsp = {error: string; status: number}

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : String(err)}`
    console.error(msg)
    writeJson<ErrorRsp>(500, {error: msg, status: 500}, rspMsg)
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const path = reqMsg.url ?? ''

  if (reqMsg.method !== 'POST') {
    writeJson<ErrorRsp>(404, {error: 'not found', status: 404}, rspMsg)
    return
  }

  switch (path) {
    case '/internal/scheduler/cycle': {
      await runCycle()
      writeJson<TaskResponse>(200, {status: 'ok'}, rspMsg)
      return
    }
    case '/internal/scheduler/process-thread': {
      const body =
        await readJson<
          TaskRequest<{phase: 'walk' | 'render'; cursor: number; skip: number}>
        >(reqMsg)
      const data = body.data ?? {phase: 'walk' as const, cursor: 0, skip: 0}
      await processThread(data)
      writeJson<TaskResponse>(200, {status: 'ok'}, rspMsg)
      return
    }
    case '/internal/scheduler/build-index': {
      await buildIndex()
      writeJson<TaskResponse>(200, {status: 'ok'}, rspMsg)
      return
    }
    case '/internal/triggers/comment-create': {
      // Reserved for the incremental accumulator described in the README.
      writeJson<TaskResponse>(200, {status: 'ok'}, rspMsg)
      return
    }
    case '/internal/menu/run-now': {
      await runCycle()
      writeJson<UiResponse>(
        200,
        {
          showToast: {
            text: 'FFBot cycle started.',
            appearance: 'success',
          },
        },
        rspMsg,
      )
      return
    }
    default:
      writeJson<ErrorRsp>(404, {error: 'not found', status: 404}, rspMsg)
      return
  }
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []
  reqMsg.on('data', chunk => chunks.push(chunk))
  await once(reqMsg, 'end')
  const raw = `${Buffer.concat(chunks)}`
  return (raw ? JSON.parse(raw) : {}) as T
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  rsp.writeHead(status, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
