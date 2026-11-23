import { createHash, randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import * as path from 'node:path'

export interface TimelineMessage {
  localId: number | string
  localType: number
  serverId?: number
  serverIdRaw?: string
  createTime: number
  senderUsername: string
  isSend: boolean
  content: string
}

function timestamp(message: TimelineMessage): number | null {
  const seconds = Number(message.createTime)
  return Number.isSafeInteger(seconds) && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime())
    ? seconds
    : null
}

function serverId(message: TimelineMessage): string | null {
  if (message.serverIdRaw && message.serverIdRaw !== '0') return message.serverIdRaw
  const id = message.serverId
  return id && Number.isSafeInteger(id) ? String(id) : null
}

export function mediaFileName(sessionId: string, message: TimelineMessage, name: string): string {
  const seconds = timestamp(message)
  const stamp =
    seconds === null
      ? 'unknown-time'
      : new Date(seconds * 1000).toISOString().replace(/:/g, '-').replace('.000Z', 'Z')
  const identity = [
    sessionId,
    String(message.localId ?? ''),
    serverId(message) || '',
    seconds,
    message.senderUsername || '',
  ]
  const tag = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16)
  const base = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  const ext = path.extname(base)
  const stem =
    path
      .basename(base, ext)
      .slice(0, 120)
      .replace(/[. ]+$/, '') || 'media'
  return [stamp, tag, stem + ext.slice(0, 24)].join('_')
}

export function callInfo(content: string) {
  const xml = String(content || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  const room = /<room_type\b[^>]*>\s*(\d+)\s*<\/room_type>/i.exec(xml)?.[1]
  const summary = (
    /<msg\b[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/msg>/i.exec(xml)?.[1] ||
    /<msg\b[^>]*>\s*([^<>]+?)\s*<\/msg>/i.exec(xml)?.[1] ||
    (xml.includes('<') ? '' : xml)
  ).trim()
  const kind =
    room === '0'
      ? 'video'
      : room === '1'
        ? 'voice'
        : /视频通话/.test(summary)
          ? 'video'
          : /语音通话/.test(summary)
            ? 'voice'
            : 'unknown'
  const duration = /(?:通话时长|duration)\s*[:：]?\s*(\d+:[0-5]\d(?::[0-5]\d)?)\b/i.exec(summary)?.[1]
  const durationSeconds = duration ? duration.split(':').reduce((n, v) => n * 60 + Number(v), 0) : null
  const statuses = [
    [/其他设备接听|其它设备接听/, 'answered_elsewhere'],
    [/忙线|busy/i, 'busy'],
    [/拒绝|declined/i, 'declined'],
    [/取消|cancel[l]?ed/i, 'canceled'],
    [/无应答|未接听|未接来电|no answer|missed/i, 'missed'],
    [/已接听/, 'answered'],
  ] as const
  const status = duration
    ? 'answered'
    : (statuses.find(([pattern]) => pattern.test(summary))?.[1] ?? 'unknown')
  return { kind, status, durationSeconds, summary } as const
}

export function callText(content: string): string {
  const { kind, summary } = callInfo(content)
  const label = { voice: '语音通话', video: '视频通话', unknown: '通话' }[kind]
  return '[' + label + ']' + (summary ? ' ' + summary : '')
}

const mediaKinds: Record<number, string> = { 3: 'image', 34: 'voice', 43: 'video', 47: 'emoji' }

// undefined means the user did not select this attachment; null means the export attempted it.
export interface TimelineOptions {
  outputPath: string
  sessionId: string
  rows: Iterable<TimelineMessage>
  mediaFor: (row: TimelineMessage) => { relativePath: string } | null | undefined
  checkCancelled: () => void
  beforePublish: (destination: string) => Promise<void>
}

export async function writeExportTimeline(options: TimelineOptions): Promise<void> {
  const destination = options.outputPath + '.timeline.jsonl'
  const temporary = destination + '.' + randomUUID() + '.tmp'
  const file = await open(temporary, 'wx')
  try {
    try {
      let buffer = ''
      let count = 0
      for (const row of options.rows) {
        if (count++ % 128 === 0) options.checkCancelled()
        const media = options.mediaFor(row)
        if (row.localType !== 50 && media === undefined) continue
        const seconds = timestamp(row)
        const record = {
          schemaVersion: 1,
          sessionId: options.sessionId,
          localId: String(row.localId ?? ''),
          serverId: serverId(row),
          timestamp: seconds,
          timeUtc: seconds === null ? null : new Date(seconds * 1000).toISOString(),
          sender: row.senderUsername || '',
          isSend: Boolean(row.isSend),
          localType: row.localType,
        }
        const details =
          row.localType === 50
            ? { type: 'call', call: callInfo(row.content) }
            : {
                type: 'media',
                kind: mediaKinds[row.localType] ?? 'file',
                relativePath: media?.relativePath ?? null,
                availability: media?.relativePath ? 'exported' : 'unavailable',
              }
        buffer += JSON.stringify({ ...record, ...details }) + '\n'
        if (buffer.length >= 65536) {
          await file.writeFile(buffer)
          buffer = ''
        }
      }
      if (buffer) await file.writeFile(buffer)
    } finally {
      await file.close()
    }
    options.checkCancelled()
    await options.beforePublish(destination)
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}
