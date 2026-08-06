import React, { useState } from 'react'
import { login } from './api.js'

export default function Lock({ onUnlock }) {
  const [passcode, setPasscode] = useState('')
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (!passcode || busy) return
    setBusy(true)
    setMessage(null)
    try {
      if (await login(passcode)) {
        onUnlock()
      } else {
        setMessage("That's not it — try again.")
        setPasscode('')
      }
    } catch (err) {
      setMessage(err.message === 'Too many tries — wait a few minutes.'
        ? err.message
        : "Couldn't reach Ember — try again in a moment.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lock">
      <svg viewBox="0 0 128 128" className="lock-icon" aria-hidden="true">
        <defs>
          <radialGradient id="lockGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#E8833A" stopOpacity="0.55" />
            <stop offset="60%" stopColor="#E8833A" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#E8833A" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="lockCoal" cx="42%" cy="38%" r="70%">
            <stop offset="0%" stopColor="#FFB877" />
            <stop offset="55%" stopColor="#E8833A" />
            <stop offset="100%" stopColor="#C2551B" />
          </radialGradient>
        </defs>
        <circle cx="64" cy="64" r="52" fill="url(#lockGlow)" />
        <circle cx="64" cy="64" r="22" fill="url(#lockCoal)" />
      </svg>
      <form className="lock-form" onSubmit={submit}>
        <input
          type="password"
          value={passcode}
          onChange={e => setPasscode(e.target.value)}
          placeholder="Passcode"
          autoFocus
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Passcode"
        />
        <button className="primary" type="submit" disabled={busy || !passcode}>
          Unlock
        </button>
      </form>
      {message && <p className="lock-message">{message}</p>}
    </div>
  )
}
