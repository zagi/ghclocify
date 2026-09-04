/** Browser notifications for long scans/imports, shown only when the tab is
 *  in the background — a visible tab already has toasts. */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** Whether the browser has already granted notification permission — used
 *  to force the checkbox off on load if permission was revoked out of band. */
export function notifyPermissionGranted(): boolean {
  return notificationsSupported() && Notification.permission === 'granted';
}

export async function requestNotifyPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

export function notifyIfHidden(title: string, body: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  if (!document.hidden) return;
  try {
    const n = new Notification(title, { body, tag: 'gh2clockify' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some browsers throw when constructing Notification directly (e.g. Android Chrome).
  }
}
