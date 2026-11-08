/**
 * admin-device-bound: the key that makes admin need this phone, not only the
 * account. A 32-byte Ed25519 secret lives in the device keychain
 * (expo-secure-store, this device only, never restored onto another phone).
 * The server holds the public key and sees a signed proof on admin calls;
 * the secret never leaves here and is never logged.
 */
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from 'expo-crypto';
import { modelName } from 'expo-device';
import { Platform } from 'react-native';

// noble 3.x signs synchronously once the sha512 hook is set.
ed.hashes.sha512 = sha512;

const KEY = 'admin-device-key-v1';
const SECRET_HEX = /^[0-9a-f]{64}$/;

type AdminKey = { secret: Uint8Array; publicKey: string; keyId: string };
export type AdminKeyState = 'ready' | 'unsupported';

let key: AdminKey | null = null;
let loading: Promise<AdminKeyState> | null = null;

type SecureStore = typeof import('expo-secure-store');

// Web (The Tester) has no keychain: the secret sits in AsyncStorage. Native
// goes through the keychain; the module is loaded lazily so a build without
// it reports `unsupported` instead of failing at startup.
const storage = Platform.select<{ read: () => Promise<string | null>; write: (hex: string) => Promise<void> }>({
  web: {
    read: () => AsyncStorage.getItem(KEY),
    write: (hex) => AsyncStorage.setItem(KEY, hex),
  },
  default: {
    read: async () => (await secureStore()).getItemAsync(KEY),
    write: async (hex) => {
      const store = await secureStore();
      await store.setItemAsync(KEY, hex, { keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    },
  },
});

function secureStore(): Promise<SecureStore> {
  return import('expo-secure-store');
}

function derive(secret: Uint8Array): AdminKey {
  const pub = ed.getPublicKey(secret);
  // The key id is the hash of the public key, so nobody can squat an id.
  return { secret, publicKey: bytesToHex(pub), keyId: bytesToHex(sha256(pub)).slice(0, 16) };
}

/** Reads the stored secret, or creates and stores one on the first admin
 * visit. Cached for the app run; safe to call before every admin request. */
export function loadAdminKey(): Promise<AdminKeyState> {
  if (key) return Promise.resolve('ready');
  if (!loading) {
    loading = (async (): Promise<AdminKeyState> => {
      try {
        const stored = await storage.read();
        if (stored && SECRET_HEX.test(stored)) {
          key = derive(hexToBytes(stored));
          return 'ready';
        }
        const secret = getRandomBytes(32);
        await storage.write(bytesToHex(secret));
        key = derive(secret);
        return 'ready';
      } catch {
        // No keychain module in this build, or the keychain refused: no key, no admin.
        loading = null;
        return 'unsupported';
      }
    })();
  }
  return loading;
}

/** First 16 hex of sha256(public key), or '' before `loadAdminKey()` resolves or when unsupported. */
export function adminKeyId(): string {
  return key?.keyId ?? '';
}

/** The public key as hex, or '' without a key. */
export function adminPublicKey(): string {
  return key?.publicKey ?? '';
}

/**
 * The `X-Shadow-Proof` value for one request: bound to the method, the
 * path (without the `/shadow` prefix) and the exact body string sent ('' for
 * none, signed as its sha256 hex), with a fresh nonce and the time in unix
 * seconds. Null without a key. Same message as backend/admin_devices.py `message`.
 */
export function proofFor(method: string, path: string, body = ''): string | null {
  if (!key) return null;
  const ts = Math.floor(Date.now() / 1000);
  const nonce = bytesToHex(getRandomBytes(16));
  const bodyHash = bytesToHex(sha256(utf8ToBytes(body)));
  const message = utf8ToBytes(`v1\n${key.keyId}\n${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${bodyHash}`);
  const sig = bytesToHex(ed.sign(message, key.secret));
  return `v1.${key.keyId}.${ts}.${nonce}.${sig}`;
}

/** The name the server lists this phone under. */
export function deviceLabel(): string {
  return modelName ?? Platform.OS;
}
