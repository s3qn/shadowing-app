/**
 * support-packs: the StoreKit seam and the support sheet's open switch.
 *
 * expo-iap is a native module, so it is loaded only on an iOS build that is
 * not Expo Go; web, Expo Go and Android get `store === null` and the sheet
 * reads "The App Store is not available right now". The purchase listener is
 * the one place a purchase is handled, so a transaction that completes while
 * the app is closed (Ask to Buy, a kill mid-purchase) is delivered and
 * verified on the next launch. A verify that fails leaves the transaction
 * unfinished and StoreKit delivers it again.
 */
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { fallbackPrice, PACKS, type Pack } from '@/constants/iap';
import { type Energy, verifyIapPurchase } from '@/lib/api';
import { ApiError } from '@/lib/api-core';
import { applyServerEnergy, devAdjustGranted } from '@/lib/energy';

type Purchase = { productId: string; purchaseState: 'pending' | 'purchased' | 'unknown'; purchaseToken?: string | null };
type Product = { id: string; displayPrice: string };
/** The slice of expo-iap this app calls, typed here so web and Expo Go never import the module. */
type Store = {
  initConnection(): Promise<boolean>;
  fetchProducts(req: { skus: string[]; type: 'in-app' }): Promise<Product[] | null>;
  requestPurchase(req: { request: { apple: { sku: string } }; type: 'in-app' }): Promise<unknown>;
  finishTransaction(req: { purchase: Purchase; isConsumable: boolean }): Promise<unknown>;
  getAvailablePurchases(): Promise<Purchase[]>;
  purchaseUpdatedListener(cb: (p: Purchase) => void): { remove(): void };
  purchaseErrorListener(cb: (e: { code?: string }) => void): { remove(): void };
  beginRefundRequestIOS?(sku: string): Promise<unknown>;
};

/** What a grant carries: the server's meter, or in dev only the amount (the fake store has no server). */
export type Grant = { amount: number; energy: Energy | null };

export type IapEvent =
  | { kind: 'status' }
  | { kind: 'pending'; packId: string }
  | ({ kind: 'granted'; packId: string } & Grant)
  | { kind: 'offline'; packId: string }
  | { kind: 'limited'; packId: string }
  | { kind: 'cancelled' }
  | { kind: 'failed' };

export type IapSim = 'success' | 'cancelled' | 'pending' | 'failed' | 'verify-offline' | 'sandbox-limit' | 'store-down' | 'restore-some' | 'restore-none';

function loadStore(): Store | null {
  if (Platform.OS !== 'ios' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return null;
  try {
    // A static import would run expo-iap's native lookup on web and in Expo Go, where it throws.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-iap') as Store;
  } catch {
    return null;
  }
}

const store = loadStore();
let inited = false;
/** Product id to Apple's localized price; null until `fetchProducts` answered, empty when it failed. */
let prices: Map<string, string> | null = null;
let fetching: Promise<void> | null = null;
let errorSeen = false;
let lastSku: string | null = null;
let sim: IapSim | null = null;
let simTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(e: IapEvent) => void>();
// Who reads `iapReady()` (the Support rows). Kept apart from `listeners`, whose
// size says whether a sheet is there to receive a grant.
const readyListeners = new Set<() => void>();

/** Puts a grant on the meter: the server's snapshot, or the fake store's amount in dev. */
export function applyGrant(g: Grant): void {
  if (g.energy) applyServerEnergy(g.energy);
  else if (__DEV__ && g.amount > 0) devAdjustGranted(g.amount);
}

function emit(e: IapEvent): void {
  // Nobody listening (the sheet is closed): a late or restored grant lands on the meter at once.
  if (e.kind === 'granted' && listeners.size === 0) applyGrant(e);
  listeners.forEach((l) => l(e));
  if (e.kind === 'status') readyListeners.forEach((l) => l());
}

function subscribeReady(l: () => void): () => void {
  readyListeners.add(l);
  // A launch without network left the prices empty: a Support row coming on screen asks again.
  if (inited) void fetchPackPrices();
  return () => {
    readyListeners.delete(l);
  };
}

/** `iapReady()` as React state: the Support rows show only once StoreKit has the products. */
export function useIapReady(): boolean {
  return useSyncExternalStore(subscribeReady, iapReady, iapReady);
}

export function subscribeIap(l: (e: IapEvent) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Whether a pill can be tapped: the store is up and the products are known. */
export function iapReady(): boolean {
  if (__DEV__ && sim !== null) return sim !== 'store-down';
  return store !== null && prices !== null && prices.size > 0;
}

/** Apple's localized price, or the USD fallback while the store is unavailable. */
export function packPrice(pack: Pack): string {
  return prices?.get(pack.id) ?? fallbackPrice(pack);
}

/** Loads the products once; a failed load is retried on the next call (the sheet calls this on open). */
export function fetchPackPrices(): Promise<void> {
  const s = store;
  if (!s || (prices && prices.size > 0)) return Promise.resolve();
  if (fetching) return fetching;
  fetching = (async () => {
    try {
      const list = await s.fetchProducts({ skus: PACKS.map((p) => p.id), type: 'in-app' });
      prices = new Map((list ?? []).map((p) => [p.id, p.displayPrice]));
    } catch {
      prices = new Map();
    } finally {
      fetching = null;
      emit({ kind: 'status' });
    }
  })();
  return fetching;
}

/** The server read the transaction and refused it for good (400 `bad_jws` or
 * `unknown_product`): finishing it is safe. Any other error (auth, network, a
 * 5xx) leaves it unfinished so StoreKit delivers it again. */
function refusedByServer(e: unknown): boolean {
  return e instanceof ApiError && e.status === 400 && (e.code === 'bad_jws' || e.code === 'unknown_product');
}

/** Verifies a purchased transaction on the server and finishes it. Null when
 * it is not done: pending, or the verify did not reach the server (left
 * unfinished, StoreKit delivers it again). `quiet` (Restore) reports nothing. */
async function settle(p: Purchase, quiet: boolean): Promise<Grant | null> {
  if (!store) return null;
  if (p.purchaseState === 'pending') {
    if (!quiet) emit({ kind: 'pending', packId: p.productId });
    return null;
  }
  if (p.purchaseState !== 'purchased' || !p.purchaseToken) return null;
  let res;
  try {
    res = await verifyIapPurchase(p.purchaseToken);
  } catch (e) {
    if (refusedByServer(e)) {
      await store.finishTransaction({ purchase: p, isConsumable: true }).catch(() => undefined);
      if (!quiet) emit({ kind: 'failed' });
      return null;
    }
    if (!quiet) emit({ kind: 'offline', packId: p.productId });
    return null;
  }
  await store.finishTransaction({ purchase: p, isConsumable: true }).catch(() => undefined);
  lastSku = p.productId;
  // A test (Sandbox) purchase over today's allowance: recorded with 0 ⚡, so no thank you and no count-up.
  if (res.code === 'sandbox_limit') {
    if (!quiet) emit({ kind: 'limited', packId: p.productId });
    return null;
  }
  const grant: Grant = { amount: res.granted, energy: res.energy };
  if (!quiet) emit({ kind: 'granted', packId: p.productId, ...grant });
  return grant;
}

/** Runs once from the support sheet host: connection, listeners, prices. */
export async function initIap(): Promise<void> {
  if (inited || !store) return;
  inited = true;
  try {
    await store.initConnection();
  } catch {
    emit({ kind: 'status' });
    return;
  }
  store.purchaseUpdatedListener((p) => {
    void settle(p, false);
  });
  store.purchaseErrorListener((e) => {
    errorSeen = true;
    emit(e.code === 'user-cancelled' ? { kind: 'cancelled' } : { kind: 'failed' });
  });
  await fetchPackPrices();
}

/** Opens Apple's sheet for one pack. What happens next arrives as events. */
export async function buyPack(pack: Pack): Promise<void> {
  if (__DEV__ && sim !== null) return fakeBuy(pack);
  if (!store || !iapReady()) {
    emit({ kind: 'failed' });
    return;
  }
  errorSeen = false;
  try {
    await store.requestPurchase({ request: { apple: { sku: pack.id } }, type: 'in-app' });
  } catch (e) {
    // The error listener usually reports first; this catches a store that threw without it.
    if (!errorSeen) emit((e as { code?: string } | null)?.code === 'user-cancelled' ? { kind: 'cancelled' } : { kind: 'failed' });
  }
}

/** Restore: every unfinished purchase goes through the same verify and finish.
 * Returns the summed grant and the latest meter. Throws when the store is unavailable. */
export async function restorePacks(): Promise<Grant> {
  if (__DEV__ && sim !== null) return fakeRestore();
  if (!store || !iapReady()) throw new Error('iap_unavailable');
  const list = await store.getAvailablePurchases();
  const out: Grant = { amount: 0, energy: null };
  for (const p of list) {
    const done = await settle(p, true);
    if (done) {
      out.amount += done.amount;
      out.energy = done.energy;
    }
  }
  return out;
}

// --- the sheet's switch ---
// `openSupportSheet()` from the energy sheet's row or Settings; `SupportSheetHost`
// in _layout.tsx renders it, like the confirm sheet, so no sheet opens over another Modal.
let sheetOpen = false;
const sheetListeners = new Set<() => void>();

export function openSupportSheet(): void {
  sheetOpen = true;
  sheetListeners.forEach((l) => l());
}

export function closeSupportSheet(): void {
  sheetOpen = false;
  sheetListeners.forEach((l) => l());
}

export function supportSheetOpen(): boolean {
  return sheetOpen;
}

export function subscribeSupportSheet(l: () => void): () => void {
  sheetListeners.add(l);
  return () => {
    sheetListeners.delete(l);
  };
}

// --- dev simulate (in memory, __DEV__ only) ---
// `iap-*` keys: a fake store that answers every tap the same way until `reset`,
// so the web walk sees each state more than once. Apple's sheet takes 600 ms,
// an Ask to Buy approval 8 s.
const APPLE_MS = 600;
const APPROVAL_MS = 8000;

export function setIapSim(s: IapSim | null): void {
  if (!__DEV__) return;
  if (simTimer) {
    clearTimeout(simTimer);
    simTimer = null;
  }
  sim = s;
  emit({ kind: 'status' });
}

function fakeBuy(pack: Pack): Promise<void> {
  return new Promise((resolve) => {
    simTimer = setTimeout(() => {
      simTimer = null;
      switch (sim) {
        case 'success':
          emit({ kind: 'granted', packId: pack.id, amount: pack.amount, energy: null });
          break;
        case 'cancelled':
          emit({ kind: 'cancelled' });
          break;
        case 'verify-offline':
          emit({ kind: 'offline', packId: pack.id });
          break;
        case 'sandbox-limit':
          emit({ kind: 'limited', packId: pack.id });
          break;
        case 'pending':
          emit({ kind: 'pending', packId: pack.id });
          simTimer = setTimeout(() => {
            simTimer = null;
            emit({ kind: 'granted', packId: pack.id, amount: pack.amount, energy: null });
          }, APPROVAL_MS);
          break;
        default:
          emit({ kind: 'failed' });
      }
      resolve();
    }, APPLE_MS);
  });
}

async function fakeRestore(): Promise<Grant> {
  await new Promise((r) => setTimeout(r, APPLE_MS));
  if (sim === 'store-down') throw new Error('iap_unavailable');
  if (sim !== 'restore-some') return { amount: 0, energy: null };
  return { amount: PACKS[0].amount, energy: null };
}

/** `iap-refund-request` (phone and sandbox only): Apple's refund sheet for the
 * last pack bought here, so a real REFUND notification reaches the dev backend. */
export function devRefundRequest(): void {
  if (!__DEV__ || !store?.beginRefundRequestIOS || !lastSku) return;
  void store.beginRefundRequestIOS(lastSku).catch(() => undefined);
}
