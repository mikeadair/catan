import { useEffect, useState } from 'react';
import {
  EmailAuthProvider,
  isSignInWithEmailLink,
  linkWithCredential,
  onAuthStateChanged,
  onIdTokenChanged,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithCredential,
  signOut as firebaseSignOut,
  updateProfile,
  type AuthCredential,
  type User,
} from 'firebase/auth';
import { auth } from './config';

// Persistence (browserLocalPersistence) is configured explicitly in ./config.ts, right after
// `auth` is created — see the comment there for why we don't rely on the SDK's implicit
// default.

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
    // onIdTokenChanged (not onAuthStateChanged) — it also fires on linkWithCredential/
    // signInWithCredential's in-place user upgrades (anonymous -> real account keeps the
    // same uid/session, so onAuthStateChanged doesn't reliably refire for it; it eventually
    // catches up on the next unrelated token refresh, which read as the UI "just sitting
    // there" for a while after a successful sign-in).
    const unsubscribe = onIdTokenChanged(auth, (user) => {
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

export interface AuthUserInfo {
  uid: string | null;
  email: string | null;
  isAnonymous: boolean;
  loading: boolean;
}

/**
 * Richer variant of useAuthUid that also exposes whether the current session has been
 * upgraded to a real (email) account. Home's sign-in UI uses this to show current
 * signed-in state and to decide whether to prefill from the persisted users/{uid} profile.
 */
export function useAuthUser(): AuthUserInfo {
  const [info, setInfo] = useState<AuthUserInfo>(() => {
    const user = auth.currentUser;
    return {
      uid: user?.uid ?? null,
      email: user && !user.isAnonymous ? user.email : null,
      isAnonymous: user?.isAnonymous ?? true,
      loading: !user,
    };
  });

  useEffect(() => {
    // See useAuthUid's comment — onIdTokenChanged catches the linkWithCredential/
    // signInWithCredential upgrade immediately instead of leaving the UI showing "guest"
    // for a while after a real sign-in actually succeeded.
    const unsubscribe = onIdTokenChanged(auth, (user) => {
      setInfo({
        uid: user?.uid ?? null,
        email: user && !user.isAnonymous ? user.email : null,
        isAnonymous: user?.isAnonymous ?? true,
        loading: false,
      });
    });

    ensureSignedIn().catch((error: unknown) => {
      console.error('Anonymous sign-in failed', error);
      setInfo((prev) => ({ ...prev, loading: false }));
    });

    return unsubscribe;
  }, []);

  return info;
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

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? (err as { code?: string }).code
    : undefined;
}

/**
 * Every guest is already signed in anonymously by the time they see a sign-in option, so
 * "signing in" with an email credential is really an upgrade: link the credential to the
 * existing anonymous user so their uid (and everything keyed on it — room membership, etc)
 * is preserved. If the email already belongs to a different, existing account, linking
 * fails with 'auth/email-already-in-use' or 'auth/credential-already-in-use' — in that case
 * we fall back to signing directly into that existing account. That intentionally abandons
 * the current anonymous session's uid (and any in-progress room membership under it); we
 * don't attempt to migrate data across uids for this edge case.
 */
async function upgradeAnonymousOrSignIn(credential: AuthCredential): Promise<User> {
  await ensureSignedIn();
  const current = auth.currentUser;
  if (!current) {
    throw new Error('Not signed in');
  }
  if (!current.isAnonymous) {
    // Already a real account (e.g. re-submitting the email-link form after completing it
    // once already this session) — just sign in normally with the same credential.
    const result = await signInWithCredential(auth, credential);
    return result.user;
  }
  try {
    const result = await linkWithCredential(current, credential);
    return result.user;
  } catch (err) {
    const code = errorCode(err);
    if (code === 'auth/email-already-in-use' || code === 'auth/credential-already-in-use') {
      const result = await signInWithCredential(auth, credential);
      return result.user;
    }
    throw err;
  }
}

/**
 * Handles both signup (new email) and login (returning email) with a single call: it
 * always attempts to link first (upgrade path), and transparently falls back to a direct
 * sign-in if the email turns out to already belong to an existing account. Wrong-password
 * on that fallback surfaces as a normal 'auth/wrong-password'/'auth/invalid-credential'
 * error from signInWithCredential.
 */
export async function signInOrLinkWithPassword(email: string, password: string): Promise<User> {
  const credential = EmailAuthProvider.credential(email, password);
  return upgradeAnonymousOrSignIn(credential);
}

const EMAIL_FOR_SIGN_IN_KEY = 'catan.emailForSignIn';

function storeEmailForSignIn(email: string) {
  try {
    localStorage.setItem(EMAIL_FOR_SIGN_IN_KEY, email);
  } catch {
    // non-fatal — completing on a different device already requires re-entering the email
  }
}

export function getStoredEmailForSignIn(): string | null {
  try {
    return localStorage.getItem(EMAIL_FOR_SIGN_IN_KEY);
  } catch {
    return null;
  }
}

function clearStoredEmailForSignIn() {
  try {
    localStorage.removeItem(EMAIL_FOR_SIGN_IN_KEY);
  } catch {
    // non-fatal
  }
}

/** Sends a passwordless sign-in link to `email`, pointing back at this app's own origin. */
export async function sendEmailSignInLink(email: string): Promise<void> {
  await sendSignInLinkToEmail(auth, email, {
    url: `${window.location.origin}/`,
    handleCodeInApp: true,
  });
  storeEmailForSignIn(email);
}

/** True if the current URL is a completed email sign-in link (i.e. the user just clicked it). */
export function isEmailLinkPending(): boolean {
  return isSignInWithEmailLink(auth, window.location.href);
}

/**
 * Completes an email-link sign-in. `email` must be supplied by the caller — usually read
 * from localStorage (same-device flow) but re-prompted for when unavailable (different
 * device than the one the link was sent from).
 */
export async function completeEmailLinkSignIn(email: string): Promise<User> {
  const credential = EmailAuthProvider.credentialWithLink(email, window.location.href);
  const user = await upgradeAnonymousOrSignIn(credential);
  clearStoredEmailForSignIn();
  // Strip the sign-in-link query params so a refresh doesn't try to replay them.
  window.history.replaceState({}, '', window.location.pathname);
  return user;
}

/**
 * Signs out of the current (real) account and drops back to a fresh anonymous session, the
 * same zero-friction state a first-time guest starts in. Any in-progress room membership
 * tied to the signed-out uid is left behind, same as the credential-conflict fallback above.
 */
export async function signOutToGuest(): Promise<void> {
  await firebaseSignOut(auth);
  signInPromise = null;
  await ensureSignedIn();
}
