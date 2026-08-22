import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User, signInWithEmailAndPassword, signOut as firebaseSignOut, onAuthStateChanged } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { Profile, Rider } from '../types';
import { api, setApiAuthToken } from '../services/api';

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
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);
      setError(null);
      if (firebaseUser) {
        setUser(firebaseUser);
        try {
          const token = await firebaseUser.getIdToken();
          setApiAuthToken(token);
          
          const res = await api.getMe();
          if (res.success && res.data && res.data.profile) {
            const userProfile = res.data.profile;
            setProfile(userProfile);
            const linkedRider = res.data.rider ?? null;
            setRider(linkedRider);

            if (!userProfile.active) {
              setError("Your employee profile is not active. Contact an administrator.");
            } else if (userProfile.role === 'rider' && !linkedRider) {
              setError("No rider profile is linked to this account. Contact an administrator.");
            }
          } else {
            setProfile(null);
            setRider(null);
            setError("Your employee profile is not active. Contact an administrator.");
          }
        } catch (err: any) {
          setProfile(null);
          setError(err.message || "Failed to load employee profile");
        }
      } else {
        setUser(null);
        setProfile(null);
        setRider(null);
        setApiAuthToken('');
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    setError(null);
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      const token = await cred.user.getIdToken();
      setApiAuthToken(token);
    } catch (err: any) {
      setLoading(false);
      let msg = "Authentication failed. Please check your credentials.";
      if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
        msg = "Invalid email or password.";
      } else if (err.message) {
        msg = err.message;
      }
      setError(msg);
      throw new Error(msg);
    }
  };

  const signOut = async () => {
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
      return token;
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
