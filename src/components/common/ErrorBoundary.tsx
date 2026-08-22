import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = {
    hasError: false,
    error: null
  };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Uncaught error in component tree:', error, errorInfo);
  }

  render() {
    const { hasError, error } = this.state;
    const { children, fallbackTitle } = this.props;

    if (hasError) {
      return (
        <div className="p-8 m-4 bg-white border border-[#DDD9D4] rounded-xl shadow-sm text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-red-100 border border-red-200 flex items-center justify-center mx-auto text-[#B43B3B]">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-[#1F1F1D]">{fallbackTitle || 'Component Error'}</h3>
            <p className="text-xs text-[#6D6964] mt-1 max-w-md mx-auto">
              {error?.message || 'An unexpected error occurred while rendering this module.'}
            </p>
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-[#5A2628] text-white text-xs font-bold rounded-lg hover:bg-[#471D1F] transition inline-flex items-center space-x-2"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Reload Module</span>
          </button>
        </div>
      );
    }

    return children;
  }
}
