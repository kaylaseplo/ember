import React, { useState } from 'react'
import Chat from './pages/Chat.jsx'
import History from './pages/History.jsx'
import Moods from './pages/Moods.jsx'
import Summaries from './pages/Summaries.jsx'

const TABS = [
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'history', label: 'History', icon: '📖' },
  { id: 'moods', label: 'Moods', icon: '📈' },
  { id: 'summaries', label: 'Insights', icon: '✨' },
]

export default function App() {
  const [tab, setTab] = useState('chat')
  const [dark, setDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  return (
    <div className={`app ${dark ? 'dark' : ''}`}>
      <header className="topbar">
        <span className="brand">Companion</span>
        <button className="theme-toggle" onClick={() => setDark(d => !d)}
                aria-label="Toggle dark mode">
          {dark ? '☀️' : '🌙'}
        </button>
      </header>

      <main className="content">
        {/* Chat stays mounted so an in-progress conversation survives tab switches */}
        <div style={{ display: tab === 'chat' ? 'contents' : 'none' }}><Chat /></div>
        {tab === 'history' && <History />}
        {tab === 'moods' && <Moods />}
        {tab === 'summaries' && <Summaries />}
      </main>

      <nav className="tabbar">
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
