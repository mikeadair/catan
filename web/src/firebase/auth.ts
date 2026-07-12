import { useEffect, useState } from 'react';
import { onAuthStateChanged, signInAnonymously, updateProfile } from 'firebase/auth';
import { auth } from './config';

// Firebase JS SDK persists anonymous auth sessions across reloads via IndexedDB
// by default, so we don't need to configure persistence explicitly here.

let signInPromise: Promise<string> | null = null;

/**
 * Ensures the current browser session is signed in (anonymously), and
 * resolves with the uid. Safe to call multiple times concurrently — callers
 * share a single in-flight sign-in attempt.
 */
export function ensureSignedIn(): Promise<string> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser.uid);
  }
  if (signInPromise) {
    return signInPromise;
  }
  signInPromise = new Promise<string>((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsubscribe();
          resolve(user.uid);
        }
      },
      (error) => {
        unsubscribe();
        signInPromise = null;
        reject(error);
      }
    );
    signInAnonymously(auth).catch((error) => {
      unsubscribe();
      signInPromise = null;
      reject(error);
    });
  });
  return signInPromise;
}

/**
 * React hook wrapping ensureSignedIn/onAuthStateChanged for components.
 * `loading` is true until the auth state (signed in or not yet resolved) is known.
 */
export function useAuthUid(): { uid: string | null; loading: boolean } {
  const [uid, setUid] = useState<string | null>(auth.currentUser?.uid ?? null);
  const [loading, setLoading] = useState<boolean>(!auth.currentUser);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUid(user ? user.uid : null);
      setLoading(false);
    });

    ensureSignedIn().catch((error: unknown) => {
      console.error('Anonymous sign-in failed', error);
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  return { uid, loading };
}

/**
 * Updates the Firebase Auth profile displayName. This is only a default —
 * the per-room PublicPlayer.displayName is the source of truth for in-game display.
 */
export async function setDisplayName(name: string): Promise<void> {
  await ensureSignedIn();
  if (!auth.currentUser) {
    throw new Error('Not signed in');
  }
  await updateProfile(auth.currentUser, { displayName: name });
}
