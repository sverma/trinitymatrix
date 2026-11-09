import { registerSW } from "virtual:pwa-register";

export function registerPwa(onUpdate: (update: () => Promise<void>) => void, onOfflineReady: () => void): void {
  if (!import.meta.env.PROD) return;
  const update = registerSW({
    immediate: false,
    onNeedRefresh: () => onUpdate(() => update(true)),
    onOfflineReady
  });
}
