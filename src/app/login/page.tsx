'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import './page.css';

export default function LoginPage() {
  const router = useRouter();
  const { supabase } = useAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  // If Supabase is not configured, show info message
  if (!supabase) {
    return (
      <div className="login-container">
        <div className="login-card glass-card">
          <div className="login-header">
            <h1 className="login-title">TradeVision AI</h1>
            <p className="login-subtitle">Authentication not configured</p>
          </div>
          <div className="login-info">
            <p>
              Supabase is not configured yet. The app is running in local-only mode
              with localStorage. To enable authentication and cloud storage:
            </p>
            <ol>
              <li>Create a Supabase project at <strong>supabase.com</strong></li>
              <li>Run the schema from <code>supabase/schema.sql</code></li>
              <li>Copy <code>.env.local.example</code> to <code>.env.local</code> and add your keys</li>
              <li>Restart the dev server</li>
            </ol>
          </div>
          <button className="btn btn-primary login-btn" onClick={() => router.push('/')}>
            Continue without account
          </button>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      if (!supabase) return;
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage('Check your email for a confirmation link!');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push('/');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <div className="login-card glass-card">
        <div className="login-header">
          <h1 className="login-title">TradeVision AI</h1>
          <p className="login-subtitle">
            {isSignUp ? 'Create your account' : 'Sign in to your account'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label className="form-label">Email</label>
            <input
              type="email"
              className="form-input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              type="password"
              className="form-input"
              placeholder="Your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>

          {error && <div className="login-error">{error}</div>}
          {message && <div className="login-message">{message}</div>}

          <button
            type="submit"
            className="btn btn-primary login-btn"
            disabled={loading}
          >
            {loading ? 'Loading...' : isSignUp ? 'Sign Up' : 'Sign In'}
          </button>
        </form>

        <div className="login-toggle">
          <span>
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}
          </span>
          <button
            className="login-toggle-btn"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError('');
              setMessage('');
            }}
          >
            {isSignUp ? 'Sign In' : 'Sign Up'}
          </button>
        </div>

        <div className="login-divider">
          <span>or</span>
        </div>

        <button
          className="btn btn-ghost login-btn"
          onClick={() => router.push('/')}
        >
          Continue without account
        </button>
      </div>
    </div>
  );
}
