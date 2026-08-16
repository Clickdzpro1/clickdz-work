// ZOOM+ — meetings data layer (persistence, types, invite generator, provider
// capability probes).
//
// WHAT ACTUALLY POWERS MEETINGS: a self-hosted La Suite Meet instance
// (meet.clickdz.ai, Django + LiveKit SFU) embedded via iframe. Meet creates a
// LiveKit *room* (by name) when someone opens/joins it — rooms are ephemeral
// and there is NO scheduled-meeting store on the Meet side. Our AFFiNE backend
// has direct LiveKit RoomService/Egress admin access (clickdz-zoomplus.service)
// which powers the REAL host controls (mute, kick, lock, recording, …).
//
// So the "schedule" (title/agenda/date/settings/recurring) is a CLIENT-SIDE
// record, persisted per-workspace in localStorage — the SAME house pattern the
// sibling shipping page uses (pickupStorageKey). The meeting's identity is its
// LiveKit room name, which we derive deterministically and hand to Meet as the
// room to open and to the host-controls backend as the `room` to administer.
//
// Nothing here is faked: creating a meeting mints a stable room name + a real
// join URL into the live Meet instance; the settings map onto real backend
// operations (lock / mute-on-entry / recording) applied by the host panel and
// the room-policy pre-apply step when a meeting starts.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-meeting settings the host chooses at creation (and can default per WS). */
export interface MeetingSettings {
  /** Show a waiting room before admitting participants. Meet-side policy. */
  waitingRoom: boolean;
  /** Require a passcode to join. */
  passcode: string;
  /** Mute every participant's mic when they join (enforced via LiveKit). */
  muteOnEntry: boolean;
  /** Start recording automatically when the meeting starts (LiveKit Egress). */
  autoRecord: boolean;
  /** Lock the room (refuse new joiners) once started. */
  lockOnStart: boolean;
}

/** A recurrence rule (lightweight — the schedule is a client convenience). */
export type Recurrence = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly';

/** A scheduled/created meeting record. */
export interface Meeting {
  id: string;
  /** The LiveKit room name — the meeting's stable identity across surfaces. */
  room: string;
  title: string;
  agenda: string;
  /** ISO start datetime (local wall-clock captured with an explicit tz). */
  startsAt: string;
  /** Duration in minutes. */
  durationMin: number;
  /** IANA timezone id the start time was authored in. */
  timezone: string;
  recurrence: Recurrence;
  /** Co-host emails (comma/space separated on entry, normalized to a list). */
  coHosts: string[];
  settings: MeetingSettings;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MEETING_SETTINGS: MeetingSettings = {
  waitingRoom: true,
  passcode: '',
  muteOnEntry: true,
  autoRecord: false,
  lockOnStart: false,
};

export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  none: 'Aucune',
  daily: 'Tous les jours',
  weekly: 'Toutes les semaines',
  weekdays: 'En semaine (lun–ven)',
  monthly: 'Tous les mois',
};

// ---------------------------------------------------------------------------
// Room-name derivation — deterministic, URL-safe, collision-resistant. The
// Meet SPA joins a room by the path segment after the base URL; the backend
// host controls administer the same string. We keep it short + lowercased.
// ---------------------------------------------------------------------------

function randomToken(len = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  try {
    const buf = new Uint8Array(len);
    (globalThis.crypto || (window as any).crypto).getRandomValues(buf);
    for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
    return out;
  } catch {
    for (let i = 0; i < len; i++)
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  }
}

/** Build a room name from the title slug + a random suffix (stable per meeting). */
export function deriveRoomName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const suffix = randomToken(8);
  return slug ? `${slug}-${suffix}` : `cdz-${suffix}`;
}

// ---------------------------------------------------------------------------
// Join URL — the REAL link into the live Meet instance for this room. The Meet
// frontend serves a room at `${base}/${room}`. We keep the base overridable via
// the same localStorage key the shell already honours (cdz.zoomplus.url) so a
// self-hoster can repoint without a rebuild.
// ---------------------------------------------------------------------------

const ZOOMPLUS_URL_KEY = 'cdz.zoomplus.url';
const DEFAULT_MEET_BASE = 'https://meet.clickdz.ai';

export function meetBaseUrl(): string {
  try {
    const override = localStorage.getItem(ZOOMPLUS_URL_KEY);
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_MEET_BASE;
}

/** The canonical join URL for a room in the live Meet instance. */
export function roomJoinUrl(room: string): string {
  return `${meetBaseUrl()}/${encodeURIComponent(room)}`;
}

// ---------------------------------------------------------------------------
// Persistence — per-workspace, localStorage. Mirrors shipping.tsx's
// pickupStorageKey idiom (the documented house pattern). Everything is
// best-effort; a blocked/absent storage degrades to an empty list, never
// throws.
// ---------------------------------------------------------------------------

function meetingsKey(slug: string): string {
  return `cdz.zoomplus.meetings.${slug}`;
}
function defaultsKey(slug: string): string {
  return `cdz.zoomplus.defaults.${slug}`;
}

function coerceSettings(raw: unknown): MeetingSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    waitingRoom: s.waitingRoom !== false,
    passcode: typeof s.passcode === 'string' ? s.passcode : '',
    muteOnEntry: s.muteOnEntry !== false,
    autoRecord: s.autoRecord === true,
    lockOnStart: s.lockOnStart === true,
  };
}

function coerceMeeting(raw: unknown): Meeting | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id : '';
  const room = typeof m.room === 'string' ? m.room : '';
  const title = typeof m.title === 'string' ? m.title : '';
  if (!id || !room) return null;
  const rec = typeof m.recurrence === 'string' ? m.recurrence : 'none';
  return {
    id,
    room,
    title: title || 'Réunion',
    agenda: typeof m.agenda === 'string' ? m.agenda : '',
    startsAt: typeof m.startsAt === 'string' ? m.startsAt : '',
    durationMin:
      typeof m.durationMin === 'number' && Number.isFinite(m.durationMin)
        ? m.durationMin
        : 30,
    timezone: typeof m.timezone === 'string' && m.timezone ? m.timezone : localTimezone(),
    recurrence: (RECURRENCE_LABELS as Record<string, string>)[rec]
      ? (rec as Recurrence)
      : 'none',
    coHosts: Array.isArray(m.coHosts)
      ? m.coHosts.filter((x): x is string => typeof x === 'string')
      : [],
    settings: coerceSettings(m.settings),
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date().toISOString(),
  };
}

/** Read all meetings for a workspace (newest-first by start time). */
export function readMeetings(slug: string): Meeting[] {
  try {
    const raw = localStorage.getItem(meetingsKey(slug));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: Meeting[] = [];
    for (const item of arr) {
      const m = coerceMeeting(item);
      if (m) out.push(m);
    }
    return out;
  } catch {
    return [];
  }
}

function writeMeetings(slug: string, meetings: Meeting[]): void {
  try {
    localStorage.setItem(meetingsKey(slug), JSON.stringify(meetings));
  } catch {
    /* best-effort */
  }
}

/** Add a meeting; returns the updated list. */
export function addMeeting(slug: string, meeting: Meeting): Meeting[] {
  const list = readMeetings(slug);
  list.push(meeting);
  writeMeetings(slug, list);
  return list;
}

/** Remove a meeting by id; returns the updated list. */
export function deleteMeeting(slug: string, id: string): Meeting[] {
  const list = readMeetings(slug).filter(m => m.id !== id);
  writeMeetings(slug, list);
  return list;
}

/** Read the per-workspace default meeting settings. */
export function readDefaults(slug: string): MeetingSettings {
  try {
    const raw = localStorage.getItem(defaultsKey(slug));
    if (!raw) return { ...DEFAULT_MEETING_SETTINGS };
    return coerceSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_MEETING_SETTINGS };
  }
}

/** Persist the per-workspace default meeting settings. */
export function writeDefaults(slug: string, settings: MeetingSettings): void {
  try {
    localStorage.setItem(defaultsKey(slug), JSON.stringify(settings));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Algiers';
  } catch {
    return 'Africa/Algiers';
  }
}

/** A compact, ordered list of tz options (Algeria first, then common ones). */
export const TIMEZONE_OPTIONS: string[] = [
  'Africa/Algiers',
  'Europe/Paris',
  'Europe/London',
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Dubai',
  'Asia/Istanbul',
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format an ISO datetime as a French human date/time (fr-DZ). */
export function formatMeetingWhen(m: Meeting): string {
  if (!m.startsAt) return 'Date non définie';
  const d = new Date(m.startsAt);
  if (Number.isNaN(d.getTime())) return m.startsAt;
  try {
    const fmt = new Intl.DateTimeFormat('fr-DZ', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: m.timezone || undefined,
    });
    return fmt.format(d);
  } catch {
    return d.toLocaleString('fr-FR');
  }
}

/** The end time of a meeting (start + duration) as an epoch ms. */
export function meetingEndMs(m: Meeting): number {
  const start = new Date(m.startsAt).getTime();
  if (Number.isNaN(start)) return 0;
  return start + m.durationMin * 60_000;
}

/** A meeting is "past" once its computed end time is behind now. */
export function isPast(m: Meeting, now = Date.now()): boolean {
  const end = meetingEndMs(m);
  return end > 0 && end < now;
}

// ---------------------------------------------------------------------------
// Invite text generator (French) — a copy-paste block for email/WhatsApp.
// ---------------------------------------------------------------------------

export function buildInviteText(m: Meeting): string {
  const lines: string[] = [];
  lines.push(`Vous êtes invité(e) à une réunion ZOOM+.`);
  lines.push('');
  lines.push(`Sujet : ${m.title}`);
  if (m.startsAt) {
    lines.push(`Quand : ${formatMeetingWhen(m)} (${m.durationMin} min)`);
    if (m.timezone) lines.push(`Fuseau horaire : ${m.timezone}`);
  }
  if (m.recurrence && m.recurrence !== 'none') {
    lines.push(`Récurrence : ${RECURRENCE_LABELS[m.recurrence]}`);
  }
  if (m.agenda.trim()) {
    lines.push('');
    lines.push(`Ordre du jour :`);
    lines.push(m.agenda.trim());
  }
  lines.push('');
  lines.push(`Rejoindre la réunion :`);
  lines.push(roomJoinUrl(m.room));
  if (m.settings.passcode.trim()) {
    lines.push(`Code d’accès : ${m.settings.passcode.trim()}`);
  }
  if (m.settings.waitingRoom) {
    lines.push('');
    lines.push(`(Une salle d’attente est activée : l’hôte vous admettra.)`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Provider capability probe — asks the host-controls backend whether the real
// LiveKit ops are wired (the /enabled flag). Recording additionally depends on
// egress being configured, which we can only learn by trying; the host panel
// hides the recording control if a start attempt reports it's unavailable.
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  /** Host controls (mute/kick/lock/participants) are wired + flag ON. */
  hostControls: boolean;
  /** AI summary endpoint is wired + flag ON. */
  summary: boolean;
}

async function probe(path: string): Promise<boolean> {
  try {
    const res = await fetch(path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { enabled?: boolean } | null;
    return !!data?.enabled;
  } catch {
    return false;
  }
}

export async function probeCapabilities(): Promise<ProviderCapabilities> {
  const [hostControls, summary] = await Promise.all([
    probe('/api/v1/zoomplus/host-controls/enabled'),
    probe('/api/v1/zoomplus/summary/enabled'),
  ]);
  return { hostControls, summary };
}

// ---------------------------------------------------------------------------
// Room policy pre-apply — when a meeting is STARTED by the host, push its
// chosen settings (lock / mute-on-entry) to the backend so the LiveKit room
// carries them before participants arrive. Recording auto-start is handled the
// same way. Each call is best-effort + fail-soft (returns which ops succeeded).
// ---------------------------------------------------------------------------

async function postJson(path: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return data?.ok !== false;
  } catch {
    return false;
  }
}

export interface AppliedPolicy {
  muteOnEntry?: boolean;
  locked?: boolean;
  recording?: boolean;
}

/**
 * Apply a meeting's settings to its live room. Called on "Démarrer". Returns
 * which policies were applied so the caller can surface partial success.
 */
export async function applyRoomPolicy(m: Meeting): Promise<AppliedPolicy> {
  const applied: AppliedPolicy = {};
  if (m.settings.muteOnEntry) {
    applied.muteOnEntry = await postJson('/api/v1/zoomplus/host/mute-on-entry', {
      room: m.room,
      enabled: true,
    });
  }
  if (m.settings.lockOnStart) {
    applied.locked = await postJson('/api/v1/zoomplus/host/lock', {
      room: m.room,
      locked: true,
    });
  }
  if (m.settings.autoRecord) {
    applied.recording = await postJson('/api/v1/zoomplus/host/recording/start', {
      room: m.room,
    });
  }
  return applied;
}
