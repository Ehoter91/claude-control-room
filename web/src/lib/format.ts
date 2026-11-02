/** "35s", "12 min", "2 h 5 min", "3 days" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 && h < 10 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

export function ago(at: number, now: number): string {
  const ms = now - at;
  if (ms < 45_000) return "just now";
  return `${duration(ms)} ago`;
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "3:30 PM" today, "Thu 9:00 AM" later. */
export function resetLabel(at: number, now: number): string {
  const d = new Date(at);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? clockTime(at) : `${d.toLocaleDateString([], { weekday: "short" })} ${clockTime(at)}`;
}

export function startedLabel(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  const yesterday = new Date(now - 86_400_000).toDateString() === d.toDateString();
  const day = today ? "today" : yesterday ? "yesterday" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${day} ${clockTime(at)}`;
}

export function money(usd: number | null): string | null {
  if (usd === null) return null;
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
