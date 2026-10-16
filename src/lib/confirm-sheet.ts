import type { verb } from '@/constants/theme';
import { t } from '@/lib/i18n';

export type ConfirmAction = {
  label: string;
  verb: keyof typeof verb;
  destructive?: boolean;
};

export type ConfirmRequest = {
  title: string;
  message?: string;
  actions: ConfirmAction[];
};

type Pending = ConfirmRequest & { resolve: (index: number) => void };

const queue: Pending[] = [];
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** Shows the app's bottom sheet and resolves with the tapped action's index,
 * or -1 when it is dismissed (backdrop, drag, Android back). A call made while
 * a sheet is open waits its turn. */
export function confirmSheet(req: ConfirmRequest): Promise<number> {
  return new Promise<number>((resolve) => {
    queue.push({ ...req, resolve });
    emit();
  });
}

/** An error-only sheet with a single OK. */
export function alertSheet(title: string, message?: string): Promise<number> {
  return confirmSheet({ title, message, actions: [{ label: t('common.ok'), verb: 'tools' }] });
}

/** The request the host should show now, or null. */
export function currentConfirm(): Pending | null {
  return queue[0] ?? null;
}

/** Called by the host once the sheet has fully left the screen. */
export function settleConfirm(index: number): void {
  const done = queue.shift();
  emit();
  done?.resolve(index);
}

export function subscribeConfirm(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
