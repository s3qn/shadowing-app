import AsyncStorage from '@react-native-async-storage/async-storage';
import * as AppleAuthentication from 'expo-apple-authentication';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';

import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from '@/lib/auth-config';
import { SESSION_STORAGE_KEY, supabase } from '@/lib/supabase';

export type SignInResult = 'ok' | 'cancelled';

let accessToken = '';
let userId = '';
let providerName: 'apple' | 'google' | '' = '';
let devBypass = false;
let subscribed = false;
let googleConfigured = false;
/** True while signOut or signOutLocal runs, so its SIGNED_OUT is not a loss. */
let signingOut = false;
/** The session ended without the user asking (revoked or expired refresh
 * token). The stale token is kept so requests fail with 401 instead of
 * quietly using the device path, until someone signs in again. */
let sessionLost = false;
const lostListeners = new Set<() => void>();

type StoredSession = { access_token?: string; user?: { id?: string; app_metadata?: { provider?: string } } };

function apply(session: StoredSession | null) {
  accessToken = session?.access_token ?? '';
  userId = session?.user?.id ?? '';
  const p = session?.user?.app_metadata?.provider;
  providerName = p === 'apple' || p === 'google' ? p : '';
  sessionLost = false;
}

/** The session as stored on the device, or null. Used when the launch
 * refresh fails (offline with an expired access token): the stored session is
 * still good, and autoRefresh renews it once the network is back. */
async function storedSession(): Promise<StoredSession | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession | null;
    return parsed && typeof parsed.access_token === 'string' && parsed.access_token ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads the stored session into the module cache and keeps it current.
 * Resolves true when someone is signed in. */
export async function loadSession(): Promise<boolean> {
  const { data, error } = await supabase.auth.getSession();
  const session = data.session ?? (error ? await storedSession() : null);
  apply(session);
  if (!subscribed) {
    subscribed = true;
    supabase.auth.onAuthStateChange((event, next) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') apply(next);
      else if (event === 'SIGNED_OUT') {
        if (signingOut || accessToken === '') apply(null);
        else {
          sessionLost = true;
          for (const cb of lostListeners) cb();
        }
      }
    });
  }
  return session !== null;
}

/** Calls `cb` when the session ends without the user signing out. Returns
 * the unsubscribe. */
export function onSessionLost(cb: () => void): () => void {
  lostListeners.add(cb);
  return () => {
    lostListeners.delete(cb);
  };
}

/** The current access token, or '' when signed out. */
export function accessTokenSync(): string {
  return accessToken;
}

/** The signed-in user's id, or empty when signed out. */
export function userIdSync(): string {
  return userId;
}

export function hasSessionSync(): boolean {
  return (accessToken !== '' && !sessionLost) || devBypass;
}

export function provider(): 'apple' | 'google' | '' {
  return providerName;
}

/** True only in a development bundle running inside Expo Go, the one place
 * native sign-in cannot run. Compiled builds are never Expo Go. */
export function canBypassSignIn(): boolean {
  return __DEV__ && Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}

/** Marks this run as using the device path. Does nothing outside Expo Go dev. */
export function allowDeviceSession(): void {
  if (!canBypassSignIn()) return;
  devBypass = true;
  // Choosing the device path drops a lost session's stale token on purpose.
  if (sessionLost) apply(null);
}

export function usingDevBypass(): boolean {
  return devBypass && accessToken === '';
}

export async function signInWithApple(): Promise<SignInResult> {
  const raw = randomUUID();
  const hashed = await digestStringAsync(CryptoDigestAlgorithm.SHA256, raw);
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashed,
    });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ERR_REQUEST_CANCELED') return 'cancelled';
    throw err;
  }
  if (!credential.identityToken) throw new Error('Apple sent no identity token.');
  const { error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
    nonce: raw,
  });
  if (error) throw error;
  return 'ok';
}

export async function signInWithGoogle(): Promise<SignInResult> {
  // Imported here: a top-level import throws in Expo Go.
  const { GoogleSignin } = await import('@react-native-google-signin/google-signin');
  if (!googleConfigured) {
    GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, iosClientId: GOOGLE_IOS_CLIENT_ID });
    googleConfigured = true;
  }
  const res = await GoogleSignin.signIn();
  if (res.type === 'cancelled') return 'cancelled';
  const token = res.data.idToken;
  if (!token) throw new Error('Google sent no identity token.');
  const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token });
  if (error) throw error;
  return 'ok';
}

export async function signOut(): Promise<void> {
  signingOut = true;
  try {
    await supabase.auth.signOut();
  } finally {
    signingOut = false;
  }
  apply(null);
}

/** After the server deleted the user: the token is dead, so clear it locally. */
export async function signOutLocal(): Promise<void> {
  signingOut = true;
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } finally {
    signingOut = false;
  }
  apply(null);
}
