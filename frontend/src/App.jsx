import React, { useState } from 'react'
import Chat from './pages/Chat.jsx'
import History from './pages/History.jsx'
import Moods from './pages/Moods.jsx'
import Summaries from './pages/Summaries.jsx'

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

  return (
    <div className={`app ${light ? 'light' : ''}`}>
      <header className="topbar">
        <span className="brand">Ember</span>
        <button className="theme-toggle" onClick={() => setLight(l => !l)}
                aria-label="Toggle light mode">
          {light ? '🌙' : '☀️'}
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
