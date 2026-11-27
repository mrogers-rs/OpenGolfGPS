// Keeps the screen on while the app is visible. Re-acquired when you come back to the app.
let lock: WakeLockSentinel | null = null;
let wanted = false;

export const wakeLockSupported = () => 'wakeLock' in navigator;

async function acquire() {
  if (!wanted || !wakeLockSupported() || document.visibilityState !== 'visible') return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; onChange?.(false); });
    onChange?.(true);
  } catch (e) {
    console.warn('wake lock failed', e);
    onChange?.(false);
  }
}

let onChange: ((on: boolean) => void) | undefined;

export function keepAwake(cb?: (on: boolean) => void) {
  wanted = true;
  onChange = cb;
  acquire();
  document.addEventListener('visibilitychange', acquire);
  // Safari can require a user gesture: try again on the first tap.
  document.addEventListener('pointerup', () => { if (!lock) acquire(); }, { passive: true });
}
