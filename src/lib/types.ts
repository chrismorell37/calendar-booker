export type TimeWindow = {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
};

/** Keys "0"–"6" (Sun–Sat). null / missing = closed that day. */
export type WeeklyHours = Record<string, TimeWindow[] | null>;

export type HostSettings = {
  slug: string;
  hostName: string;
  /** Email that receives a notification when someone books. Empty = disabled. */
  notifyEmail: string;
  timezone: string;
  bufferMinutes: number;
  slotIntervalMinutes: number;
  durations: number[];
  weeklyHours: WeeklyHours;
  meetingTitle: string;
};

export type ConnectedAccount = {
  id: number;
  email: string;
};

export type CalendarPref = {
  googleCalendarId: string;
  summary: string;
  accountId: number;
  accountEmail: string;
  checkConflicts: boolean;
  isDestination: boolean;
};

export type OAuthTokenRow = {
  id: number;
  email: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string;
  expiryDate: number | null;
};

export type PendingBooking = {
  id: number;
  slug: string;
  startIso: string;
  endIso: string;
  durationMinutes: number;
  guestName: string;
  guestEmail: string;
  guestEmails: string[];
  notes: string | null;
  summary: string;
  description: string | null;
  timezone: string;
  createdAt: string;
  fulfilledAt: string | null;
  googleEventId: string | null;
};

export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  "0": null,
  "1": [{ start: "09:00", end: "17:00" }],
  "2": [{ start: "09:00", end: "17:00" }],
  "3": [{ start: "09:00", end: "17:00" }],
  "4": [{ start: "09:00", end: "17:00" }],
  "5": [{ start: "09:00", end: "17:00" }],
  "6": null,
};

export const DEFAULT_SETTINGS: HostSettings = {
  slug: "meet",
  hostName: "Chris",
  notifyEmail: "ctmorell@gmail.com",
  timezone: "America/Los_Angeles",
  bufferMinutes: 0,
  slotIntervalMinutes: 15,
  durations: [30, 45, 60],
  weeklyHours: DEFAULT_WEEKLY_HOURS,
  meetingTitle: "Meeting with {name}",
};
