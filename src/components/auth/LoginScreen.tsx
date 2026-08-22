import React, { useState } from 'react';
import { Truck, Lock, Mail, AlertCircle, ShieldCheck, RefreshCw, Sparkles, UserCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface LoginScreenProps {
  onLoginSuccess?: () => void;
}

export function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const { signIn, resetPassword, error: authError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [localError, setLocalError] = useState('');
  const [resetMessage, setResetMessage] = useState('');

  const handleBootstrapAccounts = async () => {
    setIsBootstrapping(true);
    setLocalError('');
    setResetMessage('');
    try {
      const res = await fetch('/api/auth/bootstrap-demo-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (data.success) {
        if (!email) {
          setEmail('khan.aashir180@gmail.com');
          setPassword('SuperAdmin123!');
        }
        setResetMessage('Admin & Demo accounts successfully provisioned and verified in Firebase! You can now sign in with SuperAdmin123!.');
      } else {
        setLocalError(data.error?.message || 'Failed to initialize admin credentials.');
      }
    } catch (err: any) {
      setLocalError(err.message || 'Error connecting to server bootstrap service.');
    } finally {
      setIsBootstrapping(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setResetMessage('');
    if (!email.trim() || !password) {
      setLocalError('Please enter both email and password.');
      return;
    }

    setIsLoading(true);

    try {
      await signIn(email.trim(), password);
      if (onLoginSuccess) {
        onLoginSuccess();
      }
    } catch (err: any) {
      // Auto-attempt a bootstrap if it was an invalid credential error on first use
      const errMsg = err.message || '';
      if (errMsg.includes('Invalid') || errMsg.includes('not found')) {
        try {
          await fetch('/api/auth/bootstrap-demo-accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          // Retry signIn once after provisioning
          await signIn(email.trim(), password);
          if (onLoginSuccess) {
            onLoginSuccess();
            return;
          }
        } catch (_retryErr: any) {
          // Keep original error message
        }
      }
      setLocalError(err.message || 'Authentication failed. Please check your credentials or click "Initialize Admin Access" below.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setLocalError('');
    setResetMessage('');
    if (!email.trim()) {
      setLocalError('Please enter your email address to reset password.');
      return;
    }
    try {
      await resetPassword(email.trim());
      setResetMessage('Password reset email sent. Check your inbox.');
    } catch (err: any) {
      setLocalError(err.message || 'Failed to send reset email.');
    }
  };

  const formatAuthError = (rawErr: string | null | undefined): string => {
    if (!rawErr) return '';
    const errLower = rawErr.toLowerCase();
    if (errLower.includes('5 not_found') || errLower.includes('not_found') || errLower.includes('user-not-found') || errLower.includes('invalid') || errLower.includes('password')) {
      return 'Incorrect email or password, or account credentials need synchronization. Click "Initialize / Repair Admin Credentials" below to auto-provision access.';
    }
    return rawErr;
  };

  const displayError = formatAuthError(localError || authError);

  return (
    <div className="min-h-screen bg-[#F5F4F2] flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-[#DDD9D4] p-8 space-y-6">
        
        {/* Brand Logo Header */}
        <div className="text-center space-y-2">
          <div className="w-14 h-14 bg-[#5A2628] rounded-2xl flex items-center justify-center mx-auto shadow-md">
            <Truck className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-xl font-extrabold text-[#1F1F1D] tracking-tight">Gomila Intersole</h2>
          <p className="text-xs text-[#6D6964] font-medium">Logistics & Rider Control Operations Terminal</p>
        </div>

        {/* Error Alert Banner */}
        {displayError && (
          <div id="login-error-alert" className="p-3.5 bg-red-50 border border-red-200 rounded-xl flex items-start space-x-2 text-xs text-red-700 font-medium">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span>{displayError}</span>
              <div className="mt-2">
                <button
                  type="button"
                  onClick={handleBootstrapAccounts}
                  disabled={isBootstrapping}
                  className="inline-flex items-center space-x-1.5 px-2.5 py-1 bg-red-100 hover:bg-red-200 text-red-800 text-[11px] font-bold rounded-lg transition"
                >
                  <RefreshCw className={`w-3 h-3 ${isBootstrapping ? 'animate-spin' : ''}`} />
                  <span>{isBootstrapping ? 'Syncing...' : 'Initialize / Repair Admin Credentials'}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Success Alert Banner */}
        {resetMessage && (
          <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start space-x-2 text-xs text-emerald-700 font-medium">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <span>{resetMessage}</span>
          </div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-[11px] font-bold text-[#6D6964] uppercase tracking-wider">Email Address</label>
            <div className="relative">
              <Mail className="w-4 h-4 text-[#6D6964] absolute left-3 top-3" />
              <input
                id="email-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="employee@gomila.pk"
                className="w-full pl-9 pr-3 py-2.5 bg-[#F5F4F2] border border-[#DDD9D4] rounded-xl text-xs font-medium text-[#1F1F1D] focus:outline-none focus:ring-2 focus:ring-[#5A2628]"
              />
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <label className="text-[11px] font-bold text-[#6D6964] uppercase tracking-wider">Password</label>
              <button
                type="button"
                onClick={handleForgotPassword}
                className="text-[11px] text-[#5A2628] font-semibold hover:underline"
              >
                Forgot Password?
              </button>
            </div>
            <div className="relative">
              <Lock className="w-4 h-4 text-[#6D6964] absolute left-3 top-3" />
              <input
                id="password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-9 pr-3 py-2.5 bg-[#F5F4F2] border border-[#DDD9D4] rounded-xl text-xs font-medium text-[#1F1F1D] focus:outline-none focus:ring-2 focus:ring-[#5A2628]"
              />
            </div>
          </div>

          <button
            id="login-submit-button"
            type="submit"
            disabled={isLoading}
            className="w-full py-3 bg-[#5A2628] text-white rounded-xl font-bold text-xs hover:bg-[#471D1F] transition active:scale-98 shadow-md flex items-center justify-center space-x-2 disabled:opacity-50"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>{isLoading ? 'Authenticating...' : 'Sign In to Terminal'}</span>
          </button>
        </form>

        {/* Quick Demo Credentials */}
        <div className="pt-3 border-t border-[#DDD9D4] space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-bold text-[#6D6964] uppercase tracking-wider">Quick Admin & Demo Logins</p>
            <button
              type="button"
              onClick={handleBootstrapAccounts}
              disabled={isBootstrapping}
              title="Force sync & create default credentials in Firebase"
              className="text-[10px] text-[#5A2628] hover:underline font-bold flex items-center space-x-1"
            >
              <RefreshCw className={`w-2.5 h-2.5 ${isBootstrapping ? 'animate-spin' : ''}`} />
              <span>{isBootstrapping ? 'Syncing...' : 'Sync Accounts'}</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setEmail('superadmin@gomila.pk');
                setPassword('SuperAdmin123!');
              }}
              className="px-2.5 py-2 bg-purple-50 hover:bg-purple-100 border border-purple-200 text-purple-900 rounded-xl text-[11px] font-bold text-left transition flex items-center space-x-1.5"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-purple-700 shrink-0" />
              <div className="truncate">
                <div>Super Admin</div>
                <div className="text-[9px] font-normal text-purple-600 truncate">superadmin@gomila.pk</div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setEmail('khan.aashir180@gmail.com');
                setPassword('SuperAdmin123!');
              }}
              className="px-2.5 py-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-900 rounded-xl text-[11px] font-bold text-left transition flex items-center space-x-1.5"
            >
              <UserCheck className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
              <div className="truncate">
                <div>Aashir Khan</div>
                <div className="text-[9px] font-normal text-emerald-600 truncate">khan.aashir180@gmail.com</div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setEmail('dispatch@gomila.pk');
                setPassword('Dispatch123!');
              }}
              className="px-2.5 py-2 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-900 rounded-xl text-[11px] font-bold text-left transition flex items-center space-x-1.5"
            >
              <Sparkles className="w-3.5 h-3.5 text-blue-700 shrink-0" />
              <div className="truncate">
                <div>Dispatch Mgr</div>
                <div className="text-[9px] font-normal text-blue-600 truncate">dispatch@gomila.pk</div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => {
                setEmail('rider@gomila.pk');
                setPassword('Rider123!');
              }}
              className="px-2.5 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-900 rounded-xl text-[11px] font-bold text-left transition flex items-center space-x-1.5"
            >
              <Truck className="w-3.5 h-3.5 text-amber-700 shrink-0" />
              <div className="truncate">
                <div>Rider App</div>
                <div className="text-[9px] font-normal text-amber-600 truncate">rider@gomila.pk</div>
              </div>
            </button>
          </div>
        </div>

        <div className="pt-1 text-center text-[10px] text-[#6D6964]">
          Protected by Firebase Authentication & Cloud Firestore Rules
        </div>

      </div>
    </div>
  );
}
