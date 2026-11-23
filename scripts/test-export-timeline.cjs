// Exercise the real TypeScript formatter and cursor paths with synthetic chat records.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { transformSync } = require('esbuild')

const services = path.join(__dirname, '../electron/services')
function loadSource(file, imports = {}) {
  const filename = path.join(services, file)
  const load = createRequire(filename)
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node20',
  })
  const mod = { exports: {} }
  Function(
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    code,
  )(
    (id) => (Object.hasOwn(imports, id) ? imports[id] : load(id)),
    mod,
    mod.exports,
    path.dirname(filename),
    filename,
  )
  return mod.exports
}
const timeline = loadSource('exportTimeline.ts')
function makeService(rows, fixture) {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC'
  const wav = 'UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const emoji = path.join(path.dirname(fixture), 'emoji.png')
  fs.writeFileSync(emoji, Buffer.from(png, 'base64'))
  const wcdbService = {
    openMessageCursor: async () => ({ success: true, cursor: 1 }),
    openMessageCursorLite: async () => ({ success: true, cursor: 1 }),
    fetchMessageBatch: async () => ({ success: true, rows, hasMore: false }),
    closeMessageCursor: async () => {},
    getContact: async () => ({ success: false }),
    getDisplayNames: async () => ({}),
    getAvatarUrls: async () => ({}),
  }
  const { exportService } = loadSource('exportService.ts', {
    './exportTimeline': timeline,
    './config': { ConfigService: class {} },
    './wcdbService': { wcdbService },
    './imageDecryptService': {
      imageDecryptService: {
        resolveCachedImage: async () => ({ success: true, localPath: 'data:image/png;base64,' + png }),
      },
    },
    './videoService': { videoService: { getVideoInfo: async () => ({ exists: true, videoUrl: fixture }) } },
    './chatService': {
      chatService: {
        downloadEmojiFile: async () => emoji,
        getVoiceData: async (_session, id) => ({ success: String(id) !== '11', data: wav }),
      },
    },
    './voiceTranscribeService': {},
    './exportRecordService': {},
    './exportHtmlStyles': loadSource('exportHtmlStyles.ts'),
    '../utils/LRUCache.js': {
      LRUCache: class extends Map {
        constructor() {
          super()
        }
      },
    },
    'wechat-emojis': { getEmojiPath: () => null },
  })
  return Object.assign(exportService, {
    ensureConnected: async () => ({ success: true, cleanedWxid: 'me' }),
    getConfiguredMyWxid: () => 'me',
    getContactInfo: async (id) => ({ displayName: id }),
    preloadContacts: async () => {},
    backfillMediaFieldsFromMessageDetail: async () => {},
    preloadMediaLookupCaches: async () => {},
    preloadVoiceWavCache: async () => {},
    hydrateEmojiCaptionsForMessages: async () => {},
    resolveQuotedMessagesForExport: async () => {},
    resolveQuotedReplyDisplayWithNames: async () => null,
    formatLinkCardExportText: () => '',
    isTransferExportContent: () => false,
    runWithChatImagePipelineLimit: (fn) => fn(),
    resolveFileAttachmentCandidates: async () => [{ sourcePath: fixture, matchedBy: 'md5' }],
    resolveFileAttachmentExtensionDir: () => 'txt',
    copyFileOptimized: async (a, b) => {
      await fs.promises.copyFile(a, b)
      return { success: true }
    },
    copyMediaWithCacheAndDedup: async (_k, a, b) => {
      await fs.promises.copyFile(a, b)
      return { success: true }
    },
  })
}
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-timeline-test-'))
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }))
  return dir
}
test('JSON and media-only TXT keep original IDs, dates, media and call outcomes', async (t) => {
  const dir = workspace(t)
  const sample = path.join(dir, 'sample.mp4')
  fs.writeFileSync(sample, 'synthetic fixture')
  const time = 1700000000
  const xml = (kind, msg) =>
    '<voipmsg><room_type>' + kind + '</room_type><msg><![CDATA[' + msg + ']]></msg></voipmsg>'
  const input = [
    [1, 'hello'],
    [3, ''],
    [43, ''],
    [43, ''],
    [47, ''],
    [34, ''],
    [49, ''],
    [50, xml(0, '通话时长 01:02')],
    [50, xml(1, '未接听')],
    [50, '<voipmsg/>'],
    [34, ''],
  ]
  const rows = input.map(([local_type, message_content], i) => ({
    local_type,
    message_content,
    local_id: i + 1,
    create_time: time,
    server_id: (9007199254740993001n + BigInt(i)).toString(),
    sender_username: 'peer',
    computed_is_send: 0,
    video_md5: local_type === 43 ? 'a'.repeat(32) : '',
    image_md5: local_type === 3 ? 'abc' : '',
    ...(local_type === 49 ? { file_name: 'sample.txt', xml_type: '6' } : {}),
  }))
  const service = makeService(rows, sample)
  async function run(name, format, opts) {
    const file = path.join(dir, name + '.' + format)
    const method = format === 'json' ? 'exportSessionToDetailedJson' : 'exportSessionToTxt'
    const result = await service[method]('peer', file, { format, exportWriteLayout: 'B', ...opts })
    assert.equal(result.success, true, result.error)
    return {
      events: fs
        .readFileSync(file + '.timeline.jsonl', 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse),
      body: fs.readFileSync(file, 'utf8'),
    }
  }
  const { events, body } = await run('conversation', 'json', {
    exportMedia: true,
    exportImages: true,
    exportVideos: true,
    exportFiles: true,
    exportEmojis: true,
    exportVoices: true,
  })
  const detailed = JSON.parse(body)
  assert.equal(detailed.messages.length, 11)
  assert.equal(events.length, 10)
  const exported = events.filter((e) => e.availability === 'exported')
  assert.deepEqual(
    exported.map((e) => e.kind),
    ['image', 'video', 'video', 'emoji', 'voice', 'file'],
  )
  assert.equal(new Set(exported.map((e) => e.relativePath)).size, 6)
  for (const e of events) {
    assert.equal(e.timestamp, time)
    assert.equal(e.timeUtc, '2023-11-14T22:13:20.000Z')
    assert.equal(e.schemaVersion, 1)
    assert.equal(e.serverId, rows[Number(e.localId) - 1].server_id)
    assert.ok(detailed.messages.some((m) => m.platformMessageId === e.serverId))
  }
  for (const e of exported) {
    assert.match(path.basename(e.relativePath), /^2023-11-14T22-13-20Z_[0-9a-f]{16}_/)
    assert.ok(fs.statSync(path.join(dir, e.relativePath)).isFile())
  }
  assert.deepEqual(
    exported.filter((e) => e.kind === 'video').map((e) => e.relativePath),
    detailed.messages.filter((m) => m.localType === 43).map((m) => m.content),
  )
  assert.deepEqual(
    events.filter((e) => e.type === 'call').map((e) => e.call.kind),
    ['video', 'voice', 'unknown'],
  )
  assert.equal(events.find((e) => e.call?.kind === 'video').call.durationSeconds, 62)
  assert.equal(events.find((e) => e.call?.kind === 'voice').call.status, 'missed')
  assert.equal(events.at(-1).availability, 'unavailable')
  assert.equal(events.at(-1).relativePath, null)
  const [voices, videos] = await Promise.all([
    run('voices', 'txt', { contentType: 'voice', exportMedia: true, exportVoices: true }),
    run('videos', 'txt', { contentType: 'video', exportMedia: true, exportVideos: true }),
  ])
  assert.deepEqual(
    voices.events.map((e) => e.call?.kind || e.kind),
    ['voice', 'voice', 'voice'],
  )
  assert.deepEqual(
    videos.events.map((e) => e.call?.kind || e.kind),
    ['video', 'video', 'video'],
  )
  for (const [method, ext, format] of [
    ['exportSessionToChatLab', 'json', 'chatlab'],
    ['exportSessionToWeCloneCsv', 'csv', 'weclone'],
    ['exportSessionToExcel', 'xlsx', 'excel'],
    ['exportSessionToHtml', 'html', 'html'],
  ]) {
    const file = path.join(dir, method + '.' + ext)
    const result = await service[method]('peer', file, {
      format,
      exportWriteLayout: 'B',
      exportMedia: true,
      exportVideos: true,
    })
    assert.ok(result.success, method + ': ' + result.error)
    const index = fs
      .readFileSync(file + '.timeline.jsonl', 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.deepEqual(
      index.map((e) => e.call?.kind || e.kind),
      ['video', 'video', 'video', 'voice', 'unknown'],
      method,
    )
  }
})
test('cancelled index keeps previous contents; missing timestamps remain unknown', async (t) => {
  const dir = workspace(t),
    output = path.join(dir, 'conversation.json')
  const row = {
    localType: 50,
    localId: 1,
    serverIdRaw: '12',
    content: '已取消',
    senderUsername: 'me',
    isSend: true,
    createTime: 0,
  }
  const options = {
    sessionId: 'peer',
    outputPath: output,
    rows: [row],
    mediaFor: () => undefined,
    checkCancelled: () => {},
    beforePublish: async () => {},
  }
  await timeline.writeExportTimeline(options)
  const before = fs.readFileSync(output + '.timeline.jsonl', 'utf8')
  assert.equal(JSON.parse(before).timestamp, null)
  assert.match(timeline.mediaFileName('peer', row, 'a.wav'), /^unknown-time_/)
  await assert.rejects(
    timeline.writeExportTimeline({
      ...options,
      beforePublish: async () => {
        throw Error('stop')
      },
    }),
    /stop/,
  )
  assert.equal(fs.readFileSync(output + '.timeline.jsonl', 'utf8'), before)
  assert.equal(fs.readdirSync(dir).length, 1)
})
