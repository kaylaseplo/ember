import React, { useEffect, useState } from 'react'
import { getConversations, getConversation } from '../api.js'

export default function History() {
  const [list, setList] = useState(null)
  const [open, setOpen] = useState(null) // full conversation being viewed

  useEffect(() => { getConversations().then(setList).catch(() => setList([])) }, [])

  if (open) {
    return (
      <div className="page">
        <button className="ghost back" onClick={() => setOpen(null)}>← Back</button>
        <h2>{open.date}</h2>
        {open.mood && <p className="muted">Mood: {open.mood}/10</p>}
        {open.summary && (
          <div className="summary-block">
            <span className="summary-label">Summary</span>
            <p className="summary-text">{open.summary}</p>
          </div>
        )}
        <div className="messages readonly">
          {open.messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>{m.content}</div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <h2>Entries</h2>
      {list === null && <p className="muted">Loading…</p>}
      {list?.length === 0 && <p className="muted">Nothing saved yet — your entries will gather here.</p>}
      {list?.map(c => (
        <button key={c.id} className="card"
                onClick={() => getConversation(c.id).then(setOpen)}>
          <div className="card-head">
            <span>{c.date}</span>
            <span className="muted">{c.mood ? `${c.mood}/10` : ''}</span>
          </div>
          {c.summary && <p className="card-summary">{c.summary}</p>}
        </button>
      ))}
    </div>
  )
}
