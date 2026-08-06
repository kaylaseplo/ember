import React, { useEffect, useRef, useState } from 'react'
import { streamChat, endSession } from '../api.js'

export default function Chat() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [partial, setPartial] = useState(null)
  const [ending, setEnding] = useState(false)   // showing mood picker
  const [saving, setSaving] = useState(false)
  const [savedSummary, setSavedSummary] = useState(null)
  const scrollRef = useRef(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, partial])

  async function send() {
    const text = input.trim()
    if (!text || streaming) return
    const next = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setStreaming(true)
    setPartial('')
    try {
      const reply = await streamChat(next, setPartial)
      setMessages([...next, { role: 'assistant', content: reply }])
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: `(Something went wrong: ${e.message}. Your message wasn't lost — try sending again.)` }])
    } finally {
      setPartial(null)
      setStreaming(false)
    }
  }

  async function saveSession(mood) {
    setSaving(true)
    try {
      const res = await endSession(messages, mood)
      setSavedSummary(res.summary || 'Session saved.')
      setMessages([])
      setEnding(false)
    } catch (e) {
      alert(`Couldn't save: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  if (savedSummary !== null) {
    return (
      <div className="chat-done">
        <h2>Saved.</h2>
        <p className="summary-text">{savedSummary}</p>
        <button className="primary" onClick={() => setSavedSummary(null)}>
          Start a new entry
        </button>
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && !partial && (
          <div className="welcome">
            <h2>Welcome back.</h2>
            <p className="tagline">still here, still warm</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>{m.content}</div>
        ))}
        {partial !== null && (
          <div className="bubble assistant">{partial || <span className="typing">…</span>}</div>
        )}
      </div>

      {ending ? (
        <div className="mood-picker">
          <p>Before you go — how's your mood right now?</p>
          <div className="mood-scale">
            {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
              <button key={n} className="mood-btn" disabled={saving}
                      onClick={() => saveSession(n)}>{n}</button>
            ))}
          </div>
          <div className="mood-actions">
            <button className="ghost" disabled={saving} onClick={() => saveSession(null)}>
              Skip rating
            </button>
            <button className="ghost" disabled={saving} onClick={() => setEnding(false)}>
              Keep talking
            </button>
          </div>
          {saving && <p className="muted">Saving & summarizing…</p>}
        </div>
      ) : (
        <div className="composer">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
            placeholder="What's on your mind?"
            rows={1}
          />
          <button className="primary send" onClick={send} disabled={streaming || !input.trim()}>
            ↑
          </button>
          {messages.length > 0 && !streaming && (
            <button className="ghost end" onClick={() => setEnding(true)}>End</button>
          )}
        </div>
      )}
    </div>
  )
}
