import React, { useEffect, useState } from 'react'
import Chat from './pages/Chat.jsx'
import History from './pages/History.jsx'
import Moods from './pages/Moods.jsx'
import Summaries from './pages/Summaries.jsx'
import Login from './Login.jsx'
import Onboarding from './Onboarding.jsx'
import { getMe, logout, completeOnboarding } from './api.js'

// Monochrome line-art icons; stroke follows the tab's text color.
const icon = (paths) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
)

const TABS = [
  {
    id: 'chat', label: 'Chat',
    icon: icon(<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3c-1.5 0-2.9-.35-4.1-.97L3 20l1.2-4.3a8 8 0 0 1-1.2-4.2A8.4 8.4 0 0 1 11.5 3.2 8.4 8.4 0 0 1 21 11.5z" />),
  },
  {
    id: 'history', label: 'Entries',
    icon: icon(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></>),
  },
  {
    id: 'moods', label: 'Moods',
    icon: icon(<path d="M3 16.5l5-5 4 3.5 8-8.5" />),
  },
  {
    id: 'summaries', label: 'Insights',
    icon: icon(<><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="4" /></>),
  },
]

export default function App() {
  const [tab, setTab] = useState('chat')
  // Warm dark is Ember's default; light is the alternate.
  const [light, setLight] = useState(false)
  const [user, setUser] = useState(undefined) // undefined = checking, null = signed out
  const [showOnboarding, setShowOnboarding] = useState(false)

  useEffect(() => {
    getMe().then(u => {
      setUser(u)
      if (u && !u.onboardingCompletedAt) setShowOnboarding(true)
    })
  }, [])

  // A 401 mid-session (expired cookie) drops back to the lock screen. The app
  // tree below stays mounted (just hidden), so chat text in progress survives.
  useEffect(() => {
    const onLocked = () => setUser(null)
    window.addEventListener('ember:locked', onLocked)
    return () => window.removeEventListener('ember:locked', onLocked)
  }, [])

  async function signOut() {
    await logout()
    setUser(null)
    setShowOnboarding(false)
  }

  function signedIn(u) {
    setUser(u)
    if (!u.onboardingCompletedAt) setShowOnboarding(true)
  }

  function finishOnboarding() {
    setShowOnboarding(false)
    // Mark complete server-side (no-op if already completed — replays included)
    completeOnboarding()
    setUser(u => (u ? { ...u, onboardingCompletedAt: u.onboardingCompletedAt || new Date().toISOString() } : u))
  }

  if (user === undefined) return <div className="app" />

  const locked = !user
  const veiled = locked || showOnboarding

  return (
    <div className={`app ${light ? 'light' : ''}`}>
      {locked && <Login onSignedIn={signedIn} />}
      {!locked && showOnboarding && <Onboarding onDone={finishOnboarding} />}

      <header className="topbar" style={veiled ? { display: 'none' } : undefined}>
        <span className="brand">Ember</span>
        <span className="topbar-actions">
          <button className="theme-toggle" onClick={() => setLight(l => !l)}
                  aria-label="Toggle light mode">
            {light ? '🌙' : '☀️'}
          </button>
          <button className="theme-toggle signout" onClick={() => setShowOnboarding(true)}
                  aria-label="Replay the introduction">
            Intro
          </button>
          <button className="theme-toggle signout" onClick={signOut} aria-label="Sign out">
            Sign out
          </button>
        </span>
      </header>

      <main className="content" style={veiled ? { display: 'none' } : undefined}>
        {/* Chat stays mounted so an in-progress conversation survives tab switches */}
        <div style={{ display: tab === 'chat' ? 'contents' : 'none' }}>
          <Chat firstTime={!user?.hasConversations}
                onSessionSaved={() => setUser(u => (u ? { ...u, hasConversations: true } : u))} />
        </div>
        {tab === 'history' && <History />}
        {tab === 'moods' && <Moods />}
        {tab === 'summaries' && <Summaries />}
      </main>

      <nav className="tabbar" style={veiled ? { display: 'none' } : undefined}>
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
