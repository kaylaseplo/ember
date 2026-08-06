import React, { useEffect, useState } from 'react'
import Chat from './pages/Chat.jsx'
import History from './pages/History.jsx'
import Moods from './pages/Moods.jsx'
import Summaries from './pages/Summaries.jsx'
import Lock from './Lock.jsx'
import { getSession, logout } from './api.js'

const TABS = [
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'history', label: 'Entries', icon: '📖' },
  { id: 'moods', label: 'Moods', icon: '📈' },
  { id: 'summaries', label: 'Insights', icon: '✨' },
]

export default function App() {
  const [tab, setTab] = useState('chat')
  // Warm dark is Ember's default; light is the alternate.
  const [light, setLight] = useState(false)
  const [authed, setAuthed] = useState(null) // null = checking

  useEffect(() => {
    getSession().then(setAuthed)
  }, [])

  // A 401 mid-session (expired cookie) drops back to the lock screen. The app
  // tree below stays mounted (just hidden), so chat text in progress survives.
  useEffect(() => {
    const onLocked = () => setAuthed(false)
    window.addEventListener('ember:locked', onLocked)
    return () => window.removeEventListener('ember:locked', onLocked)
  }, [])

  async function lock() {
    await logout()
    setAuthed(false)
  }

  if (authed === null) return <div className="app" />

  const locked = !authed

  return (
    <div className={`app ${light ? 'light' : ''}`}>
      {locked && <Lock onUnlock={() => setAuthed(true)} />}

      <header className="topbar" style={locked ? { display: 'none' } : undefined}>
        <span className="brand">Ember</span>
        <span className="topbar-actions">
          <button className="theme-toggle" onClick={() => setLight(l => !l)}
                  aria-label="Toggle light mode">
            {light ? '🌙' : '☀️'}
          </button>
          <button className="theme-toggle" onClick={lock} aria-label="Lock Ember">
            🔒
          </button>
        </span>
      </header>

      <main className="content" style={locked ? { display: 'none' } : undefined}>
        {/* Chat stays mounted so an in-progress conversation survives tab switches */}
        <div style={{ display: tab === 'chat' ? 'contents' : 'none' }}><Chat /></div>
        {tab === 'history' && <History />}
        {tab === 'moods' && <Moods />}
        {tab === 'summaries' && <Summaries />}
      </main>

      <nav className="tabbar" style={locked ? { display: 'none' } : undefined}>
        {TABS.map(t => (
          <button key={t.id}
                  className={`tab ${tab === t.id ? 'active' : ''}`}
                  onClick={() => setTab(t.id)}>
            <span className="tab-icon">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
