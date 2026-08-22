import React, { useState } from 'react';
import { Truck, Lock, Mail, AlertCircle, ShieldCheck, Smartphone, LayoutDashboard } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface LoginScreenProps {
  onLoginSuccess?: () => void;
}

export function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const { signIn, resetPassword, error: authError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [localError, setLocalError] = useState('');
  const [resetMessage, setResetMessage] = useState('');

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
      setLocalError(err.message || 'Authentication failed. Please check your credentials.');
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

  const displayError = localError || authError;

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
            <span>{displayError}</span>
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
                placeholder="employee@gomila.com"
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
          <p className="text-[10px] font-bold text-[#6D6964] uppercase tracking-wider text-center">Quick Demo Terminal Credentials</p>
          <div className="grid grid-cols-3 gap-1.5">
            <button
              type="button"
              onClick={() => {
                setEmail('superadmin@gomila.pk');
                setPassword('SuperAdmin123!');
              }}
              className="px-2 py-1.5 bg-purple-50 hover:bg-purple-100 border border-purple-200 text-purple-900 rounded-lg text-[11px] font-bold text-center transition"
            >
              Super Admin
            </button>
            <button
              type="button"
              onClick={() => {
                setEmail('dispatch@gomila.pk');
                setPassword('Dispatch123!');
              }}
              className="px-2 py-1.5 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-900 rounded-lg text-[11px] font-bold text-center transition"
            >
              Dispatch Mgr
            </button>
            <button
              type="button"
              onClick={() => {
                setEmail('rider@gomila.pk');
                setPassword('Rider123!');
              }}
              className="px-2 py-1.5 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-900 rounded-lg text-[11px] font-bold text-center transition"
            >
              Rider App
            </button>
          </div>
        </div>

        <div className="pt-2 text-center text-[10px] text-[#6D6964]">
          Protected by Firebase Authentication & Cloud Firestore Rules
        </div>

      </div>
    </div>
  );
}
