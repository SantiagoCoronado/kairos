import { ipcMain, BrowserWindow, session, systemPreferences } from 'electron'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { IpcApi, IpcEvents } from '../shared/ipc-contract'
import { getDb, DATA_DIR } from './db'
import { exportMarkdown } from '../core/export/markdown'
import { calendarToday } from './calendar'
import { searchMacContacts } from './contacts'
import { ChatManager } from './chat/agent'
import { getSettings, saveSettings } from './settings'
import { getClaudeLimits, getClaudeUsageStats, getClaudeUsageToday } from './claude-usage'
import { reregisterCaptureHotkey } from './hotkey'
import { execFile } from 'node:child_process'
import * as tasks from '../core/repo/tasks'
import * as notes from '../core/repo/notes'
import * as agentTasksRepo from '../core/repo/agent-tasks'
import { AgentTaskRunner, parseTaskDraft } from './chat/task-runner'
import { smartCapture, smartCaptureInstruct } from './chat/smart-capture'
import { emitAppEvent, onAppEvent } from './events'
import type { AppEventName, RsvpResponse } from '../core/types'
import * as projects from '../core/repo/projects'
import * as people from '../core/repo/people'
import * as interactions from '../core/repo/interactions'
import * as followups from '../core/repo/followups'
import { todayAgenda } from '../core/repo/today'
import {
  pendingItems,
  snoozeItem,
  unsnoozeItem,
  dismissItem,
  undismissItem,
  markAllSeen,
  unseenRunCount,
  gcPendingOverlay
} from '../core/repo/pending'
import { composeBriefing } from '../core/briefing'
import { DEFAULT_VOICE_ID, listVoices, synthesize, transcribe } from './tts/elevenlabs'
import { executeCapture } from '../core/capture'
import { hideCaptureWindow } from './windows/capture-window'
import { openWithDeepLink } from './windows/main-window'
import { claimDeepLink } from './deeplink'
import * as comms from '../core/repo/comms'
import * as calendarRepo from '../core/repo/calendar'
import * as meetingsRepo from '../core/repo/meetings'
import { MeetingManager } from './meetings'
import { makeDisplayMediaHandler } from './display-media'
import { ensureModelFile, isModelPresent, VAD_MODEL, WHISPER_MODELS } from './models'
import { WhisperServer } from './whisper'
import { MeetingProcessor, type Transcriber } from './meeting-processor'
import { summarizeMeeting } from './chat/meeting-summarizer'
import { undoFanOutTasks } from '../core/meeting-summary'
import { spawn as childSpawn } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import { app, Notification, shell } from 'electron'
import { localDate } from '../core/ids'
import { CommsSyncManager } from './comms/manager'
import { CommsNotifier } from './comms/notifier'
import { attachViaDialog, attachPaths } from './chat/uploads'
import { CalendarSyncManager } from './gcal/manager'
import { TerminalManager } from './terminal'
import { spawn as ptySpawn } from 'node-pty'
import { logLine } from './logger'
import { syncRemoteServer, getRemoteStatus, remoteBroadcast } from './remote/server'

const SLOW_IPC_MS = 300

// every handler also lands here so the remote-access server can dispatch the
// same contract over WebSocket (see remote/server.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ipcHandlers = new Map<string, (...args: any[]) => unknown>()

function handle<K extends keyof IpcApi>(
  channel: K,
  fn: (...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]>
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcHandlers.set(channel, fn as (...args: any[]) => unknown)
  ipcMain.handle(channel, async (_event, ...args) => {
    const started = Date.now()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (fn as any)(...args)
    } catch (err) {
      logLine('error', 'ipc', `${channel} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      throw err
    } finally {
      const ms = Date.now() - started
      if (ms > SLOW_IPC_MS && channel !== 'log:renderer')
        logLine('warn', 'ipc', `slow ${channel}: ${ms}ms`)
    }
  })
}

export function broadcast<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
  remoteBroadcast(channel, payload)
}

let commsManager: CommsSyncManager | null = null

export function getCommsManager(): CommsSyncManager | null {
  return commsManager
}

let taskRunner: AgentTaskRunner | null = null

export function getTaskRunner(): AgentTaskRunner | null {
  return taskRunner
}

let terminalManager: TerminalManager | null = null

export function getTerminalManager(): TerminalManager | null {
  return terminalManager
}

let calendarManager: CalendarSyncManager | null = null

export function getCalendarManager(): CalendarSyncManager | null {
  return calendarManager
}

let meetingManager: MeetingManager | null = null

export function getMeetingManager(): MeetingManager | null {
  return meetingManager
}

let meetingProcessor: MeetingProcessor | null = null
let whisperServer: WhisperServer | null = null
let whisperKey: string | null = null

/** quit-time: stop the retention timer and kill the sidecar. A job that
 *  was mid-transcription is NOT re-enqueued here on purpose — its row is
 *  still 'processing', so the next launch's sweepIncomplete retries it. */
export function shutdownMeetings(): void {
  meetingProcessor?.stopMaintenance()
  whisperServer?.stop()
}

function whisperBinaryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'whisper', 'whisper-server')
    : join(app.getAppPath(), 'resources', 'whisper', 'whisper-server')
}

/** per-job transcriber: models ensured (downloading if needed), sidecar
 *  recreated when the model or language setting changed since last job */
async function getTranscriber(onProgress: (received: number, total: number) => void): Promise<Transcriber> {
  const s = getSettings()
  const modelsDir = join(DATA_DIR, 'models')
  const info = WHISPER_MODELS[s.meetingModel]
  const modelPath = await ensureModelFile(modelsDir, info, onProgress)
  const vadModelPath = await ensureModelFile(modelsDir, VAD_MODEL)
  const key = `${modelPath}|${s.meetingLanguage ?? 'auto'}`
  if (whisperServer && whisperKey !== key) {
    whisperServer.stop()
    whisperServer = null
  }
  if (!whisperServer) {
    whisperServer = new WhisperServer(
      { binaryPath: whisperBinaryPath(), modelPath, vadModelPath, language: s.meetingLanguage },
      {
        spawn: (file, args) => childSpawn(file, args, { stdio: 'ignore' }),
        fetchFn: fetch,
        readFile,
        log: (level, message) => logLine(level, 'whisper', message)
      }
    )
    whisperKey = key
  }
  const server = whisperServer
  return {
    modelName: s.meetingModel,
    transcribe: (wavPath) => server.transcribe(wavPath)
  }
}

export function registerIpc(): void {
  const db = getDb()

  // Deliberately raw ipcMain.handle, NOT the shared handle(): the claim is
  // desktop-only by construction. A notification click on the Mac is desktop
  // intent — a remote client that could claim it would navigate the phone
  // because something was clicked on the desktop.
  ipcMain.handle('nav:claim', () => claimDeepLink())

  // MCP-twin writes (dist-mcp shares the WAL db from another process) never
  // pass through these handlers, so nothing broadcasts for them. SQLite's
  // data_version bumps only when a DIFFERENT connection commits — poll it
  // and refresh the whole UI when it moves.
  let dataVersion: number | null = null
  setInterval(() => {
    try {
      const v = db.get<{ data_version: number }>('PRAGMA data_version')?.data_version ?? null
      if (v === null) return // keep the last-good baseline on a fluke read
      if (dataVersion !== null && v !== dataVersion) {
        broadcast('db:changed', { entity: 'all' })
      }
      dataVersion = v
    } catch {
      // a transient read failure must never kill the poll loop
    }
  }, 4000)

  handle('app:ping', () => 'pong')
  handle('log:renderer', (level, message) => logLine(level, 'renderer', message.slice(0, 4000)))

  handle('tasks:list', (f) => tasks.listTasks(db, f))
  handle('tasks:create', (input) => {
    const t = tasks.createTask(db, input)
    broadcast('db:changed', { entity: 'tasks' })
    emitAppEvent('task_created')
    return t
  })
  handle('tasks:update', (id, patch) => {
    const t = tasks.updateTask(db, id, patch)
    broadcast('db:changed', { entity: 'tasks' })
    return t
  })
  handle('tasks:delete', (id) => {
    tasks.deleteTask(db, id)
    broadcast('db:changed', { entity: 'tasks' })
  })
  handle('tasks:reorder', (id, beforeId) => {
    tasks.moveTaskBefore(db, id, beforeId)
    broadcast('db:changed', { entity: 'tasks' })
  })

  handle('notes:list', (f) => notes.listNotes(db, f))
  handle('notes:create', (input) => {
    const n = notes.createNote(db, input)
    broadcast('db:changed', { entity: 'notes' })
    emitAppEvent('note_created')
    return n
  })
  handle('notes:update', (id, patch) => {
    const n = notes.updateNote(db, id, patch)
    broadcast('db:changed', { entity: 'notes' })
    return n
  })
  handle('notes:delete', (id) => {
    notes.deleteNote(db, id)
    broadcast('db:changed', { entity: 'notes' })
  })
  handle('notes:reorder', (id, beforeId) => {
    notes.moveNoteBefore(db, id, beforeId)
    broadcast('db:changed', { entity: 'notes' })
  })
  handle('notes:toggleItem', (id, index) => {
    const n = notes.toggleItem(db, id, index)
    broadcast('db:changed', { entity: 'notes' })
    return n
  })
  handle('notes:labels', () => notes.listLabels(db))
  handle('notes:dueCount', () => notes.dueNoteCount(db))

  // reads the module-level manager at call time — the chat stack is built
  // before the CalendarSyncManager exists
  const respondInvite = async (eventId: string, response: RsvpResponse): Promise<void> => {
    if (!calendarManager) throw new Error('calendar sync is not running')
    await calendarManager.respond(eventId, response)
    broadcast('db:changed', { entity: 'pending' })
  }

  const runner = new AgentTaskRunner(
    db,
    (entity) => broadcast('db:changed', { entity }),
    (view, id) => openWithDeepLink({ view, id }),
    { respondInvite }
  )
  taskRunner = runner

  handle('agentTasks:list', () => agentTasksRepo.listAgentTasks(db))
  handle('agentTasks:create', (input) => {
    const t = agentTasksRepo.createAgentTask(db, input)
    broadcast('db:changed', { entity: 'agent_tasks' })
    return t
  })
  handle('agentTasks:update', (id, patch) => {
    const t = agentTasksRepo.updateAgentTask(db, id, patch)
    broadcast('db:changed', { entity: 'agent_tasks' })
    return t
  })
  handle('agentTasks:delete', (id) => {
    runner.stop(id)
    agentTasksRepo.deleteAgentTask(db, id)
    broadcast('db:changed', { entity: 'agent_tasks' })
  })
  handle('agentTasks:pause', (id) => {
    const t = agentTasksRepo.pauseAgentTask(db, id)
    broadcast('db:changed', { entity: 'agent_tasks' })
    return t
  })
  handle('agentTasks:resume', (id) => {
    const t = agentTasksRepo.resumeAgentTask(db, id)
    broadcast('db:changed', { entity: 'agent_tasks' })
    return t
  })
  handle('agentTasks:runNow', (id) => {
    runner.enqueue(id)
  })
  handle('agentTasks:stop', (id) => {
    runner.stop(id)
  })
  handle('agentTasks:runs', (taskId, limit) => agentTasksRepo.listRuns(db, taskId, limit))
  handle('agentTasks:recentRuns', (limit) => agentTasksRepo.recentRuns(db, limit))
  handle('agentTasks:usage', () => agentTasksRepo.usageByTask(db))
  handle('agentTasks:parse', (text) => parseTaskDraft(text))

  // Unseen-runs badge: the watermark now lives in pending_overlay per run
  // (shared with the Pending inbox, so the two badges can never disagree) —
  // the old settings.automationsSeenAt cursor is retired. Same TTL shape as
  // the pending flag below: a vanished remote client expires instead of
  // pinning "seen" forever; the Automations view re-arms from its tick.
  const AUTOMATIONS_ACTIVE_TTL_MS = 90_000
  let automationsViewActiveUntil = 0
  const automationsViewActive = (): boolean => Date.now() < automationsViewActiveUntil
  handle('agentTasks:setViewActive', (active) => {
    const was = automationsViewActive()
    automationsViewActiveUntil = active ? Date.now() + AUTOMATIONS_ACTIVE_TTL_MS : 0
    // both transitions: every run visible up to this moment counts as seen
    const stamped = markAllSeen(db, new Date(), 'agent_run')
    if (was !== active) broadcast('db:changed', { entity: 'agent_tasks' })
    // the runs just marked seen also count into the Pending badge — notify
    // only when something actually changed, so this can't loop
    if (stamped.length > 0) broadcast('db:changed', { entity: 'pending' })
  })
  handle('agentTasks:activity', () => {
    if (automationsViewActive()) {
      const stamped = markAllSeen(db, new Date(), 'agent_run')
      if (stamped.length > 0) broadcast('db:changed', { entity: 'pending' })
    }
    return {
      running: agentTasksRepo.runningCount(db),
      // open view = seen by definition, even mid-burst
      unseenFinished: automationsViewActive() ? 0 : unseenRunCount(db)
    }
  })

  // event-triggered automations: count occurrences, fire on every Nth.
  // A task never triggers itself (isRunning guard) and nothing fires while
  // the master switch is off.
  const TRIGGERABLE: AppEventName[] = [
    'email_received',
    'message_received',
    'task_created',
    'note_created',
    'interaction_logged'
  ]
  for (const eventName of TRIGGERABLE) {
    onAppEvent(eventName, () => {
      if (!getSettings().automationsEnabled) return
      let changed = false
      for (const t of agentTasksRepo.listEventTasks(db, eventName)) {
        if (runner.isRunning(t.id)) continue
        changed = true
        if (agentTasksRepo.bumpTriggerCounter(db, t.id)) runner.enqueue(t.id)
      }
      if (changed) broadcast('db:changed', { entity: 'agent_tasks' })
    })
  }

  handle('projects:list', (f) => projects.listProjects(db, f))
  handle('projects:create', (input) => {
    const p = projects.createProject(db, input)
    broadcast('db:changed', { entity: 'projects' })
    return p
  })

  handle('people:list', (f) => people.listPeople(db, f))
  handle('people:detail', (id) => people.getPersonDetail(db, id) ?? null)
  handle('people:upsert', (input) => {
    const p = people.upsertPerson(db, input)
    broadcast('db:changed', { entity: 'people' })
    return p
  })
  handle('people:archive', (id) => {
    people.archivePerson(db, id)
    // archived people disappear from thread person-joins too
    broadcast('db:changed', { entity: 'people' })
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('people:unarchive', (id) => {
    people.unarchivePerson(db, id)
    broadcast('db:changed', { entity: 'people' })
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('people:delete', (id) => {
    people.deletePerson(db, id)
    broadcast('db:changed', { entity: 'people' })
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('people:identities', (personId) => comms.listIdentitiesForPerson(db, personId))
  handle('people:findByContact', (emails, phones) => people.findPersonByContact(db, emails, phones) ?? null)

  handle('interactions:log', (input) => {
    const i = interactions.logInteraction(db, input)
    broadcast('db:changed', { entity: 'interactions' })
    broadcast('db:changed', { entity: 'people' })
    emitAppEvent('interaction_logged')
    return i
  })

  handle('followups:due', () => followups.followupsDue(db))
  handle('followups:statuses', () => followups.followupStatuses(db))
  handle('followups:snooze', (personId, untilDate) => {
    people.snoozeFollowup(db, personId, untilDate)
    broadcast('db:changed', { entity: 'people' })
  })
  handle('followups:clearSnooze', (personId) => {
    people.clearSnooze(db, personId)
    broadcast('db:changed', { entity: 'people' })
  })

  handle('today:get', () => todayAgenda(db))

  // While the view is open, whatever it shows counts as seen — stamped lazily
  // inside pending:list so a burst of db:changed events can't badge items the
  // user is literally looking at. The stamp deliberately does NOT broadcast:
  // pending:list runs on every 'pending' invalidation, so a broadcast here
  // would re-trigger itself forever. Clients converge on the next event.
  //
  // The active flag is process-wide and remote clients dispatch to it too; a
  // client that vanishes mid-view never sends its unmount `false`, so the
  // flag is a TTL the open view re-arms from its own tick — it self-heals
  // instead of pinning "seen" forever.
  const PENDING_ACTIVE_TTL_MS = 90_000
  // overlay GC otherwise runs only on triage writes — one boot sweep bounds
  // leftover rows from items that resolved while nothing was being triaged
  gcPendingOverlay(db)
  let pendingViewActiveUntil = 0
  const pendingViewActive = (): boolean => Date.now() < pendingViewActiveUntil
  // stamping a run seen here must also refresh the Automations badge — but
  // only when something was actually stamped, so the cross-broadcast can't
  // loop (the very next pass stamps nothing and stays silent)
  const crossNotifyRuns = (stampedKeys: string[]): void => {
    if (stampedKeys.some((k) => k.startsWith('agent_run:')))
      broadcast('db:changed', { entity: 'agent_tasks' })
  }
  handle('pending:list', () => {
    if (pendingViewActive()) crossNotifyRuns(markAllSeen(db))
    return pendingItems(db)
  })
  handle('pending:setViewActive', (active) => {
    const was = pendingViewActive()
    pendingViewActiveUntil = active ? Date.now() + PENDING_ACTIVE_TTL_MS : 0
    // both transitions: everything visible up to this moment counts as seen
    crossNotifyRuns(markAllSeen(db))
    // transition-only broadcast — a periodic re-arm must not cause a reload storm
    if (was !== active) broadcast('db:changed', { entity: 'pending' })
  })
  handle('pending:snooze', (key, untilIso) => {
    snoozeItem(db, key, untilIso)
    broadcast('db:changed', { entity: 'pending' })
  })
  handle('pending:unsnooze', (key) => {
    unsnoozeItem(db, key)
    broadcast('db:changed', { entity: 'pending' })
  })
  handle('pending:dismiss', (key) => {
    dismissItem(db, key)
    broadcast('db:changed', { entity: 'pending' })
  })
  handle('pending:undismiss', (key) => {
    undismissItem(db, key)
    broadcast('db:changed', { entity: 'pending' })
  })

  handle('calendar:today', () => calendarToday())

  handle('tts:voices', async () => {
    const key = getSettings().elevenLabsApiKey
    if (!key) return { ok: false as const, message: 'No ElevenLabs API key configured.' }
    try {
      return { ok: true as const, voices: await listVoices(key) }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('tts:briefing', async () => {
    const { elevenLabsApiKey: key, elevenLabsVoiceId } = getSettings()
    if (!key) return { ok: false as const, message: 'Add an ElevenLabs API key in Settings first.' }
    try {
      const cal = await calendarToday()
      const p = pendingItems(db)
      const text = composeBriefing(todayAgenda(db), 'events' in cal ? cal.events : [], new Date(), {
        failures: p.danger,
        invites: p.items.filter((i) => i.kind === 'invite').length
      })
      const mp3 = await synthesize(key, elevenLabsVoiceId ?? DEFAULT_VOICE_ID, text)
      return { ok: true as const, dataUrl: `data:audio/mpeg;base64,${mp3.toString('base64')}` }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('stt:transcribe', async (audioBase64, mime) => {
    const key = getSettings().elevenLabsApiKey
    if (!key) return { ok: false as const, message: 'Add an ElevenLabs API key in Settings first.' }
    try {
      const text = await transcribe(key, Buffer.from(audioBase64, 'base64'), mime)
      if (!text) return { ok: false as const, message: 'Heard nothing — try again closer to the mic.' }
      return { ok: true as const, text }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('contacts:search', (query) => searchMacContacts(query))

  // DB-backed calendar: local CRUD on SQLite, with the CalendarSyncManager
  // pushing dirty rows to Google and pulling remote changes in the background.
  const calManager = new CalendarSyncManager(
    db,
    (event) => broadcast('calendar:event', event),
    (entity) => broadcast('db:changed', { entity })
  )
  calendarManager = calManager

  handle('calendarEvents:list', (startIso, endIso) =>
    calendarRepo.listEventsInRange(db, startIso, endIso)
  )
  handle('calendarEvents:create', (input) => {
    const e = calendarRepo.createEvent(db, input)
    broadcast('db:changed', { entity: 'calendar_events' })
    calManager.pokePush()
    return e
  })
  handle('calendarEvents:update', (id, patch) => {
    const e = calendarRepo.updateEvent(db, id, patch)
    broadcast('db:changed', { entity: 'calendar_events' })
    calManager.pokePush()
    return e
  })
  handle('calendarEvents:delete', (id) => {
    calendarRepo.deleteEvent(db, id)
    broadcast('db:changed', { entity: 'calendar_events' })
    calManager.pokePush()
  })
  handle('calendarEvents:addMeet', (id) => calManager.addMeet(id))
  // same path the calendar_respond tool uses (also refreshes Pending)
  handle('calendar:respond', (eventId, response) => respondInvite(eventId, response))
  handle('calendar:calendars', () => calendarRepo.listCalendars(db))
  handle('calendar:setVisible', (calendarId, visible) => {
    calendarRepo.setCalendarVisible(db, calendarId, visible)
    broadcast('db:changed', { entity: 'calendars' })
    broadcast('db:changed', { entity: 'calendar_events' })
    // a newly-visible google calendar may never have synced (visibility gates the pull)
    if (visible) {
      const cal = calendarRepo.getCalendar(db, calendarId)
      if (cal?.account_id) calManager.syncNow(cal.account_id)
    }
  })
  // Meeting capture: system audio arrives via getDisplayMedia loopback —
  // the handler answers every request synchronously (a skipped callback
  // leaves getDisplayMedia pending forever; see display-media.ts) with the
  // requesting frame as the throwaway video source; the renderer streams
  // recorded chunks back over meetings:chunk.
  // NOTE: this grants loopback to ANY request in defaultSession with no
  // origin gate — fine while every page is first-party, but must be
  // revisited if a <webview>/embedded origin ever lands in this session.
  session.defaultSession.setDisplayMediaRequestHandler(
    makeDisplayMediaHandler({
      screenPermission: () =>
        process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : null,
      log: (message) => logLine('info', 'meetings', message)
    }),
    { useSystemPicker: false }
  )
  // the Dock is the one place that stays visible with Kairos in the
  // background — a live mic must never be a surprise on Cmd+Tab
  // cosmetic: must never be able to fail the state transition it follows
  const showRecordingBadge = (): void => {
    if (process.platform !== 'darwin') return
    try {
      app.dock?.setBadge(meetMgr.activeMeetingId ? (meetMgr.paused ? 'PAUSED' : 'REC') : '')
    } catch (err) {
      logLine('warn', 'meetings', `dock badge failed: ${String(err)}`)
    }
  }
  const meetMgr = new MeetingManager(db, join(DATA_DIR, 'recordings'), () => {
    broadcast('db:changed', { entity: 'meetings' })
    showRecordingBadge()
  })
  meetingManager = meetMgr
  meetMgr.recoverOrphans()

  // one summarize per meeting at a time: auto-summarize + a Summarize click
  // in the same window must not race two paid model calls
  const summarizing = new Set<string>()
  const runSummarize = async (
    id: string,
    force = false
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (summarizing.has(id)) return { ok: true }
    summarizing.add(id)
    let res: Awaited<ReturnType<typeof summarizeMeeting>>
    try {
      res = await summarizeMeeting(db, id, { force })
    } finally {
      summarizing.delete(id)
    }
    if (!res.ok) return res
    broadcast('db:changed', { entity: 'meetings' })
    if (res.taskIds.length) broadcast('db:changed', { entity: 'tasks' })
    if (res.interactionCount) broadcast('db:changed', { entity: 'interactions' })
    broadcast('meetings:event', {
      kind: 'summarized',
      meetingId: id,
      taskIds: res.taskIds,
      interactionCount: res.interactionCount
    })
    return { ok: true }
  }

  const processor = new MeetingProcessor(db, join(DATA_DIR, 'recordings'), {
    getTranscriber: () =>
      getTranscriber((received, total) => {
        broadcast('meetings:event', {
          kind: 'model-progress',
          file: WHISPER_MODELS[getSettings().meetingModel].file,
          received,
          total
        })
      }),
    fs: {
      size: (path) => {
        try {
          return statSync(path).size
        } catch {
          return null
        }
      },
      rm: (path) => rmSync(path, { force: true })
    },
    onEvent: (ev) => broadcast('meetings:event', ev),
    onChange: () => broadcast('db:changed', { entity: 'meetings' }),
    notify: (title, body, meetingId) => {
      if (!Notification.isSupported()) return
      const n = new Notification({ title, body, silent: true })
      // id rides along so the renderer can focus the row — in Meetings, the
      // one list that also holds ad-hoc recordings and partials needing Retry
      n.on('click', () => openWithDeepLink({ view: 'meetings', id: meetingId }))
      n.show()
    },
    log: (level, message) => logLine(level, 'meetings', message),
    summarize: async (id) => {
      await runSummarize(id)
    }
  })
  meetingProcessor = processor
  processor.sweepIncomplete()
  processor.startMaintenance(() => getSettings().meetingAudioRetentionDays)

  handle('meetings:list', (f) => meetingsRepo.listMeetings(db, f))
  handle('meetings:get', (id) => {
    const meeting = meetingsRepo.getMeeting(db, id)
    if (!meeting) throw new Error(`meeting not found: ${id}`)
    return { meeting, transcript: meetingsRepo.getTranscript(db, id) ?? null }
  })
  handle('meetings:start', (input) => meetMgr.start(input))
  handle('meetings:stop', (id) => {
    meetMgr.stop(id)
    // finalized on disk — hand straight to the transcription queue
    processor.enqueue(id)
    return meetingsRepo.getMeeting(db, id)!
  })
  handle('meetings:pause', (id) => {
    meetMgr.pause(id)
    showRecordingBadge()
  })
  handle('meetings:resume', (id) => {
    meetMgr.resume(id)
    showRecordingBadge()
  })
  handle('meetings:chunk', (id, channel, kind, dataBase64) =>
    meetMgr.appendChunk(id, channel, kind, Buffer.from(dataBase64, 'base64'))
  )
  handle('meetings:delete', (id) => meetMgr.delete(id))
  handle('meetings:retranscribe', (id) => processor.retry(id))
  handle('meetings:rename', (id, title) => {
    const m = meetingsRepo.updateMeeting(db, id, { title: title.trim() })
    broadcast('db:changed', { entity: 'meetings' })
    return m
  })
  handle('meetings:reveal', (id) => {
    if (!meetingsRepo.getMeeting(db, id)) throw new Error(`meeting not found: ${id}`)
    // the id is a ULID from our own row, so it can't walk out of the dir
    shell.showItemInFolder(join(DATA_DIR, 'recordings', id))
  })
  handle('meetings:active', () => meetMgr.activeMeetingId)
  handle('meetings:summarize', (id, force) => runSummarize(id, force ?? false))
  handle('meetings:undoTasks', (id, taskIds) => {
    undoFanOutTasks(db, id, taskIds)
    broadcast('db:changed', { entity: 'tasks' })
    broadcast('db:changed', { entity: 'meetings' })
  })
  let modelDownloading = false
  handle('meetings:modelStatus', async () => {
    const modelsDir = join(DATA_DIR, 'models')
    const model = getSettings().meetingModel
    return {
      model,
      modelPresent: await isModelPresent(modelsDir, WHISPER_MODELS[model]),
      vadPresent: await isModelPresent(modelsDir, VAD_MODEL),
      downloading: modelDownloading
    }
  })
  handle('meetings:downloadModel', async () => {
    if (modelDownloading) return { ok: true as const }
    modelDownloading = true
    try {
      const modelsDir = join(DATA_DIR, 'models')
      const info = WHISPER_MODELS[getSettings().meetingModel]
      let lastPct = -1
      await ensureModelFile(modelsDir, info, (received, total) => {
        const pct = Math.floor((received / total) * 100)
        if (pct !== lastPct) {
          lastPct = pct
          broadcast('meetings:event', { kind: 'model-progress', file: info.file, received, total })
        }
      })
      await ensureModelFile(modelsDir, VAD_MODEL)
      broadcast('meetings:event', { kind: 'model-ready' })
      return { ok: true as const }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      broadcast('meetings:event', { kind: 'model-error', message })
      return { ok: false as const, message }
    } finally {
      modelDownloading = false
    }
  })
  handle('meetings:audioData', async (id, channel) => {
    const m = meetingsRepo.getMeeting(db, id)
    const path = channel === 'mic' ? m?.mic_path : m?.system_path
    if (!m || !path) return { ok: false as const, message: 'No audio for this channel.' }
    if (m.audio_deleted_at) return { ok: false as const, message: 'Audio was deleted.' }
    try {
      // async read: an hour-long webm is tens of MB — a sync read here would
      // stall every IPC reply (see the stall watchdog in index.ts)
      const bytes = await readFile(path)
      return { ok: true as const, dataUrl: `data:audio/webm;base64,${bytes.toString('base64')}` }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('calendar:accounts', () => calendarRepo.listCalendarAccounts(db))
  handle('calendar:connectGoogle', async () => {
    try {
      return { ok: true as const, account: await calManager.connectGoogle() }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('calendar:disconnect', async (accountId) => {
    calManager.disconnect(accountId)
  })
  handle('calendar:syncNow', (accountId) => calManager.syncNow(accountId))
  handle('calendar:pokeSync', () => calManager.pokePull())
  handle('calendar:attendeeSuggest', (query) => {
    const q = query.trim()
    if (!q) return []
    // people first (named contacts beat raw addresses), then past attendees
    const fromPeople = people
      .listPeople(db, { search: q })
      .filter((p) => p.email)
      .map((p) => ({ email: p.email!.toLowerCase(), name: p.name as string | null }))
    const fromEvents = calendarRepo.suggestAttendees(db, q)
    const seen = new Set<string>()
    const out: { email: string; name: string | null }[] = []
    for (const s of [...fromPeople, ...fromEvents]) {
      if (seen.has(s.email)) continue
      seen.add(s.email)
      out.push(s)
      if (out.length >= 8) break
    }
    return out
  })
  handle('calendar:overlay', (startIso, endIso) => ({
    // tasks carry date-only due dates (local-day concept) — convert the ISO
    // window bounds to local dates before comparing
    tasks: tasks.listTasksDueBetween(db, localDate(new Date(startIso)), localDate(new Date(endIso))),
    notes: notes.listNotesRemindBetween(db, startIso, endIso),
    agentTasks: agentTasksRepo.listAgentTasksNextRunBetween(db, startIso, endIso)
  }))

  handle('capture:submit', (raw) => {
    const result = executeCapture(db, raw)
    if (!result.ok) return { ok: false as const, message: result.message }
    broadcast('db:changed', {
      entity:
        result.kind === 'task' ? 'tasks' : result.kind === 'note' ? 'notes' : 'interactions'
    })
    if (result.kind === 'interaction') broadcast('db:changed', { entity: 'people' })
    emitAppEvent(
      result.kind === 'task'
        ? 'task_created'
        : result.kind === 'note'
          ? 'note_created'
          : 'interaction_logged'
    )
    return {
      ok: true as const,
      message:
        result.kind === 'task'
          ? `Task: ${result.task.title}${result.task.due_date ? ` (due ${result.task.due_date})` : ''}`
          : result.kind === 'note'
            ? `Note: ${result.note.title}`
            : `Logged for ${result.person.name}`
    }
  })
  handle('capture:smart', async (raw, kind) => {
    const result = await smartCapture(db, raw, kind)
    if (result.ok && result.entity) broadcast('db:changed', { entity: result.entity })
    if (result.ok && result.entity === 'interactions')
      broadcast('db:changed', { entity: 'people' })
    if (result.ok && result.appEvent) emitAppEvent(result.appEvent)
    return { ok: result.ok, message: result.message }
  })
  handle('capture:instruct', async (instruction, context) => {
    const result = await smartCaptureInstruct(db, instruction, context)
    if (result.ok && result.entity) broadcast('db:changed', { entity: result.entity })
    if (result.ok && result.entity === 'interactions')
      broadcast('db:changed', { entity: 'people' })
    if (result.ok && result.appEvent) emitAppEvent(result.appEvent)
    return { ok: result.ok, message: result.message }
  })

  handle('capture:hide', () => hideCaptureWindow())

  handle('export:markdown', () => {
    const dir = join(DATA_DIR, 'export')
    const { files } = exportMarkdown(db, dir)
    return { files, dir }
  })

  const chat = new ChatManager(
    db,
    (event) => broadcast('chat:event', event),
    (entity) => broadcast('db:changed', { entity }),
    { respondInvite }
  )
  handle('chat:send', (localSessionId, text) => chat.send(localSessionId, text))
  handle('chat:attach', () => attachViaDialog())
  handle('chat:attachPaths', (paths) => attachPaths(paths))
  handle('notes:solve', (id, itemIndex) => {
    const note = notes.getNote(db, id)
    if (!note) throw new Error(`note not found: ${id}`)
    const { localSessionId } = chat.send(null, buildSolvePrompt(note, itemIndex))
    notes.updateNote(db, id, { agent_session_id: localSessionId })
    broadcast('db:changed', { entity: 'notes' })
    return { sessionId: localSessionId }
  })
  handle('chat:interrupt', (localSessionId) => chat.interrupt(localSessionId))
  handle('chat:sessions', (limit, includeAutomations) => chat.listSessions(limit, includeAutomations))
  handle('chat:history', (localSessionId) => chat.getHistory(localSessionId))
  handle('chat:renameSession', (localSessionId, title) => chat.renameSession(localSessionId, title))
  handle('chat:deleteSession', (localSessionId) => chat.deleteSession(localSessionId))
  handle('chat:draft', (input) => chat.draftReply(input))

  const terminals = new TerminalManager(
    ptySpawn,
    (event) => broadcast('terminal:event', event),
    () => broadcast('db:changed', { entity: 'terminal' })
  )
  terminalManager = terminals
  handle('terminal:create', () => terminals.create())
  handle('terminal:list', () => terminals.list())
  handle('terminal:attach', (sessionId) => terminals.attach(sessionId))
  handle('terminal:input', (sessionId, data) => terminals.input(sessionId, data))
  handle('terminal:resize', (sessionId, cols, rows) => terminals.resize(sessionId, cols, rows))
  handle('terminal:kill', (sessionId) => terminals.kill(sessionId))
  handle('terminal:setViewActive', (active) => terminals.setViewActive(active))
  handle('terminal:attentionCount', () => terminals.attentionCount())

  const notifier = new CommsNotifier(db, (view, id) => openWithDeepLink({ view, id }))
  const manager = new CommsSyncManager(
    db,
    (event) => broadcast('comms:event', event),
    () => broadcast('db:changed', { entity: 'comms' }),
    (provider) => {
      emitAppEvent('message_received')
      if (provider === 'gmail') emitAppEvent('email_received')
      notifier.noteInbound(provider)
    },
    (threadIds) => notifier.noteLabeled(threadIds),
    (threadIds) => notifier.noteImportant(threadIds),
    (count) => notifier.noteTriageDeferred(count)
  )
  commsManager = manager

  handle('comms:accounts', () => comms.listAccounts(db))
  handle('comms:unreadTotal', () => comms.unreadTotal(db))
  handle('comms:threads', (f) => comms.listThreads(db, f))
  handle('comms:thread', (threadId) => comms.getThreadListItem(db, threadId))
  handle('comms:search', (query, opts) => comms.searchMessages(db, query, opts))
  handle('comms:accountThreads', (accountId) => comms.listAccountThreads(db, accountId))
  handle('comms:messages', (threadId) => comms.listMessages(db, threadId))
  handle('comms:threadAttachments', (threadId) => comms.listThreadAttachments(db, threadId))
  handle('comms:downloadAttachment', (attachmentId) => manager.downloadAttachment(attachmentId))
  handle('comms:attachmentData', (attachmentId) => manager.getAttachmentData(attachmentId))
  handle('comms:markRead', (threadId) => {
    manager.markRead(threadId) // local immediately; gmail propagation in background
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:markUnread', (threadId) => {
    manager.markUnread(threadId)
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:pinThread', (threadId, pinned) => {
    comms.setThreadPinned(db, threadId, pinned)
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:labels', () => comms.listThreadLabels(db))
  handle('comms:setThreadLabels', (threadId, labels) => {
    comms.setThreadLabels(db, threadId, labels)
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:archiveThread', (threadId, archived) => manager.setThreadArchived(threadId, archived))
  handle('comms:deleteThread', (threadId) => manager.deleteThread(threadId))
  handle('comms:reorderAccount', (id, beforeId) => {
    comms.moveAccountBefore(db, id, beforeId)
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:send', (input) => manager.sendNow(input))
  handle('comms:retryOutbox', (outboxId) => manager.retryOutbox(outboxId))
  handle('comms:discardOutbox', (outboxId) => {
    comms.deleteOutboxItem(db, outboxId)
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:syncNow', (accountId) => manager.syncNow(accountId))
  handle('comms:linkSender', (provider, handle_, personId) => {
    comms.linkHandleToPerson(db, provider, handle_.trim().toLowerCase(), personId)
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:unlinkSender', (provider, handle_) => {
    comms.unlinkHandle(db, provider, handle_.trim().toLowerCase())
    broadcast('db:changed', { entity: 'comms' })
    broadcast('db:changed', { entity: 'people' })
  })
  handle('comms:setThreadSync', (threadId, enabled) => {
    comms.setThreadSyncEnabled(db, threadId, enabled)
    if (enabled) {
      const thread = comms.getThread(db, threadId)
      if (thread) manager.syncNow(thread.account_id)
    }
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:setThreadsSync', (threadIds, enabled) => {
    comms.setThreadsSyncEnabled(db, threadIds, enabled)
    if (enabled && threadIds.length > 0) {
      const thread = comms.getThread(db, threadIds[0])
      if (thread) manager.syncNow(thread.account_id)
    }
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:refreshChannels', (accountId) => manager.refreshChannels(accountId))
  handle('comms:connectGmail', () => wrapConnect(manager.connectGmail()))
  handle('comms:connectSlack', () => wrapConnect(manager.connectSlack()))
  handle('comms:connectWhatsApp', () =>
    wrapConnect(Promise.resolve().then(() => manager.connectWhatsApp()))
  )
  handle('comms:disconnect', async (accountId) => {
    manager.disconnect(accountId)
  })

  handle('settings:get', () => getSettings())
  handle('settings:set', (patch) => {
    const before = getSettings()
    const next = saveSettings(patch)
    if (next.captureHotkey !== before.captureHotkey) reregisterCaptureHotkey(next.captureHotkey)
    if (next.remoteAccess !== before.remoteAccess || next.remotePort !== before.remotePort)
      syncRemoteServer(ipcHandlers)
    broadcast('db:changed', { entity: 'settings' })
    return next
  })
  handle('remote:status', () => getRemoteStatus())
  handle('settings:authStatus', () => checkAuthStatus())
  handle('usage:claudeToday', () => getClaudeUsageToday())
  handle('usage:claudeStats', () => getClaudeUsageStats())
  handle('usage:claudeLimits', () => getClaudeLimits())

  // all handlers are registered — bring the remote server up if enabled
  syncRemoteServer(ipcHandlers)
}

/** turn a note (or one of its checklist items) into an agent instruction */
function buildSolvePrompt(
  note: import('../core/types').Note,
  itemIndex?: number
): string {
  const lines: string[] = []
  if (itemIndex !== undefined && note.items[itemIndex]) {
    lines.push(
      `Help me complete this item from my note "${note.title || 'untitled'}" (note id ${note.id}):`,
      `- ${note.items[itemIndex].text}`,
      '',
      `Do the work with your tools where possible. When it is done, check it off with note_toggle_item (id "${note.id}", index ${itemIndex}), then summarize briefly.`
    )
    return lines.join('\n')
  }
  lines.push(`Help me work through this note (note id ${note.id}):`)
  if (note.title) lines.push(`Title: ${note.title}`)
  if (note.content) lines.push(`Content: ${note.content}`)
  const open = note.items
    .map((it, i) => ({ ...it, i }))
    .filter((it) => !it.done)
  if (open.length > 0) {
    lines.push('Open items:')
    for (const it of open) lines.push(`- [index ${it.i}] ${it.text}`)
  }
  lines.push(
    '',
    `Do the work with your tools where possible. Check off items you complete with note_toggle_item (id "${note.id}", the index shown), and finish with a short summary of what you did and what still needs me.`
  )
  return lines.join('\n')
}

async function wrapConnect(
  p: Promise<import('../core/comms-types').CommsAccount>
): Promise<import('../shared/ipc-contract').CommsConnectResult> {
  try {
    return { ok: true, account: await p }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

function checkAuthStatus(): Promise<import('../shared/ipc-contract').AuthStatus> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env['ANTHROPIC_API_KEY']
    env['PATH'] = [env['PATH'], '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':')
    execFile('claude', ['auth', 'status'], { env, timeout: 15_000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, message: 'claude CLI not reachable — is Claude Code installed?' })
        return
      }
      try {
        const s = JSON.parse(stdout) as {
          loggedIn: boolean
          email?: string
          subscriptionType?: string
        }
        resolve(
          s.loggedIn
            ? { ok: true, email: s.email ?? '?', subscriptionType: s.subscriptionType ?? '?' }
            : { ok: false, message: 'not logged in — run `claude login` in a terminal' }
        )
      } catch {
        resolve({ ok: false, message: 'could not parse `claude auth status` output' })
      }
    })
  })
}
