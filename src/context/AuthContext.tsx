import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User, signInWithEmailAndPassword, signInWithCustomToken, signOut as firebaseSignOut, onAuthStateChanged } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { Profile, Rider } from '../types';
import { api, setApiAuthToken } from '../services/api';

const SESSION_STORAGE_KEY = 'gomila_auth_session_token';

export interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  rider: Rider | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  signOutUser: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  getFreshToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [rider, setRider] = useState<Rider | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    // Check existing stored session token on startup
    const checkSavedSession = async () => {
      const savedToken = localStorage.getItem(SESSION_STORAGE_KEY);
      if (savedToken) {
        setApiAuthToken(savedToken);
        try {
          const res = await api.getMe();
          if (res.success && res.data && res.data.profile) {
            if (isMounted) {
              setProfile(res.data.profile);
              setRider(res.data.rider ?? null);
              setUser({
                uid: res.data.profile.authUserId || res.data.profile.id,
                email: res.data.profile.email,
                displayName: res.data.profile.fullName
              } as any);
              setLoading(false);
              return true;
            }
          }
        } catch (_) {
          localStorage.removeItem(SESSION_STORAGE_KEY);
        }
      }
      return false;
    };

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        if (isMounted) setUser(firebaseUser);
        try {
          const token = await firebaseUser.getIdToken();
          setApiAuthToken(token);
          localStorage.setItem(SESSION_STORAGE_KEY, token);
          
          const res = await api.getMe();
          if (res.success && res.data && res.data.profile) {
            const userProfile = res.data.profile;
            if (isMounted) {
              setProfile(userProfile);
              const linkedRider = res.data.rider ?? null;
              setRider(linkedRider);

              if (!userProfile.active) {
                setError("Your employee profile is not active. Contact an administrator.");
              } else if (userProfile.role === 'rider' && !linkedRider) {
                setError("No rider profile is linked to this account. Contact an administrator.");
              }
            }
          } else if (isMounted) {
            setProfile(null);
            setRider(null);
            setError("Your employee profile is not active. Contact an administrator.");
          }
        } catch (err: any) {
          if (isMounted) {
            setProfile(null);
            setError(err.message || "Failed to load employee profile");
          }
        }
        if (isMounted) setLoading(false);
      } else {
        // If not in Firebase client Auth, check if custom session token exists in localStorage
        checkSavedSession().then((hasSession) => {
          if (!hasSession && isMounted) {
            setUser(null);
            setProfile(null);
            setRider(null);
            setApiAuthToken('');
            setLoading(false);
          }
        });
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    setError(null);
    setLoading(true);
    const cleanEmail = email.trim();

    try {
      // 1. Authenticate with backend bootstrap & login authority
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail, password })
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error?.message || "Invalid email or password.");
      }

      // If backend issued a custom token, sign into Firebase Auth client
      let firebaseSignedIn = false;
      if (data.customToken) {
        try {
          const cred = await signInWithCustomToken(auth, data.customToken);
          const idToken = await cred.user.getIdToken();
          setApiAuthToken(idToken);
          localStorage.setItem(SESSION_STORAGE_KEY, idToken);
          firebaseSignedIn = true;
        } catch (customErr: any) {
          console.warn("Client signInWithCustomToken fallback:", customErr?.message);
        }
      }

      // If Firebase client auth could not sign in, use the verified sessionToken
      if (!firebaseSignedIn && data.sessionToken) {
        setApiAuthToken(data.sessionToken);
        localStorage.setItem(SESSION_STORAGE_KEY, data.sessionToken);
        setUser({
          uid: data.data.profile.authUserId || data.data.profile.id,
          email: data.data.profile.email,
          displayName: data.data.profile.fullName
        } as any);
        setProfile(data.data.profile);
        setRider(data.data.rider ?? null);
      } else {
        // Fetch loaded profile
        const meRes = await api.getMe();
        if (meRes.success && meRes.data) {
          setProfile(meRes.data.profile);
          setRider(meRes.data.rider ?? null);
        }
      }
    } catch (err: any) {
      // Direct Firebase email/password fallback
      try {
        const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
        const token = await cred.user.getIdToken();
        setApiAuthToken(token);
        localStorage.setItem(SESSION_STORAGE_KEY, token);
      } catch (fbErr: any) {
        let msg = "Invalid email or password.";
        if (err.message && !err.message.includes("Unexpected")) {
          msg = err.message;
        } else if (fbErr.code === 'auth/invalid-credential' || fbErr.code === 'auth/wrong-password' || fbErr.code === 'auth/user-not-found') {
          msg = "Invalid email or password.";
        }
        setError(msg);
        throw new Error(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const signOut = async () => {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    try {
      await firebaseSignOut(auth);
    } catch (_) {}
    setApiAuthToken('');
    setUser(null);
    setProfile(null);
    setRider(null);
    setError(null);
  };

  const signOutUser = signOut;

  const resetPassword = async (email: string) => {
    setError(null);
    try {
      const { sendPasswordResetEmail } = await import('firebase/auth');
      await sendPasswordResetEmail(auth, email.trim());
    } catch (err: any) {
      setError(err.message || "Failed to send password reset email");
      throw err;
    }
  };

  const getFreshToken = async (): Promise<string | null> => {
    if (auth.currentUser) {
      const token = await auth.currentUser.getIdToken(true);
      setApiAuthToken(token);
      localStorage.setItem(SESSION_STORAGE_KEY, token);
      return token;
    }
    const saved = localStorage.getItem(SESSION_STORAGE_KEY);
    if (saved) {
      setApiAuthToken(saved);
      return saved;
    }
    return null;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        rider,
        loading,
        error,
        signIn,
        signOut,
        signOutUser,
        resetPassword,
        getFreshToken
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
