import React, { Component, ErrorInfo, ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#050505] text-zinc-300 flex items-center justify-center p-4 font-mono">
          <div className="max-w-md w-full bg-black border border-red-900/50 p-8 space-y-6">
            <div className="flex items-center gap-4 text-red-500">
              <ShieldAlert className="w-8 h-8" />
              <h1 className="text-xl uppercase tracking-widest">System Error</h1>
            </div>
            
            <div className="space-y-2">
              <p className="text-sm text-zinc-400">
                The application encountered an unexpected error.
              </p>
              {this.state.error && (
                <div className="bg-red-950/20 border border-red-900/30 p-4 text-xs text-red-400/80 overflow-auto max-h-48 whitespace-pre-wrap">
                  {this.state.error.message}
                </div>
              )}
            </div>

            <button
              onClick={() => window.location.reload()}
              className="w-full bg-red-950/50 text-red-500 border border-red-900/50 py-3 hover:bg-red-900/50 transition-colors uppercase tracking-widest text-sm"
            >
              Restart System
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
