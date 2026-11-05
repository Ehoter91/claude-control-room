export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  current: boolean;
  width: number;
  height: number;
}

/** What the Electron shell adds; absent when the dashboard runs in a normal browser tab. */
export interface NativeBridge {
  focusWindow(): void;
  setBadge(count: number, items: { pid: number; name: string; label: string }[]): void;
  onSelect(fn: (pid: number) => void): void;
  displays(): Promise<DisplayInfo[]>;
  openWall(displayId: number): void;
  popout(pid: number, displayId: number | null): void;
  moveToDisplay(displayId: number): void;
  toggleFullScreen(): void;
  openMain(pid: number | null): void;
  hidePanel(): void;
  setPanelHeight(height: number): void;
  showMenu(kind: "more" | "walls"): void;
  loginItem(): Promise<boolean>;
  setLoginItem(on: boolean): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  copyText(text: string): Promise<boolean>;
}

export const native: NativeBridge | null = (window as unknown as { controlRoom?: NativeBridge }).controlRoom ?? null;

export function popoutSession(pid: number): void {
  if (native) native.popout(pid, null);
  else window.open(`/?session=${pid}`, `cr-session-${pid}`, "width=760,height=860");
}

export function openWallWindow(displayId: number | null): void {
  if (native && displayId !== null) native.openWall(displayId);
  else window.open("/?view=wall", "cr-wall", "width=1600,height=1000");
}
