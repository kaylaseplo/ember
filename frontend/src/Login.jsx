import React, { useState } from 'react'
import { login, signup } from './api.js'

function Coal() {
  return (
    <svg viewBox="0 0 128 128" className="lock-icon" aria-hidden="true">
      <defs>
        <radialGradient id="lockGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FE7133" stopOpacity="0.7" />
          <stop offset="55%" stopColor="#F75629" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#F75629" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lockCoal" cx="42%" cy="38%" r="70%">
          <stop offset="0%" stopColor="#FFA36B" />
          <stop offset="55%" stopColor="#FE7133" />
          <stop offset="100%" stopColor="#D63C23" />
        </radialGradient>
      </defs>
      <circle cx="64" cy="64" r="52" fill="url(#lockGlow)" />
      <circle cx="64" cy="64" r="22" fill="url(#lockCoal)" />
    </svg>
  )
}

export default function Login({ onSignedIn }) {
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (busy || !email || !password) return
    setBusy(true)
    setMessage(null)
    try {
      const user =
        mode === 'signup'
          ? await signup(email, password, inviteCode)
          : await login(email, password)
      onSignedIn(user)
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next) {
    setMode(next)
    setMessage(null)
  }

  return (
    <div className="lock">
      <Coal />
      <h2 className="auth-heading">{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h2>
      <form className="lock-form auth-form" onSubmit={submit}>
        {mode === 'signup' && (
          <input
            type="text"
            value={inviteCode}
            onChange={e => setInviteCode(e.target.value)}
            placeholder="Invite code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Invite code"
          />
        )}
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Email"
        />
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          aria-label="Password"
        />
        <button className="primary" type="submit"
                disabled={busy || !email || !password || (mode === 'signup' && !inviteCode)}>
          {mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
      </form>
      {message && <p className="lock-message">{message}</p>}
      {mode === 'login' ? (
        <p className="auth-switch">
          Have an invite code?{' '}
          <button className="link" onClick={() => switchMode('signup')}>Sign up</button>
        </p>
      ) : (
        <p className="auth-switch">
          Already have an account?{' '}
          <button className="link" onClick={() => switchMode('login')}>Sign in</button>
        </p>
      )}
    </div>
  )
}
