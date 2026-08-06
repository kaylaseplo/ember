import React, { useEffect, useState } from 'react'
import { getSummaries } from '../api.js'

export default function Summaries() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  useEffect(() => { getSummaries().then(setData).catch(() => setError(true)) }, [])

  if (error) return <div className="page"><p className="muted">Couldn't load insights.</p></div>
  if (!data) return <div className="page"><p className="muted">Looking for patterns across your sessions…</p></div>

  return (
    <div className="page">
      <h2>Insights</h2>
      {data.patterns ? (
        <div className="patterns">
          <h3>Patterns across recent sessions</h3>
          <p className="summary-text prewrap">{data.patterns}</p>
        </div>
      ) : (
        <p className="muted">
          After a couple of saved sessions, patterns across them will show up here.
        </p>
      )}
      {data.sessions.length > 0 && <h3>Session summaries</h3>}
      {data.sessions.map(s => (
        <div key={s.id} className="card static">
          <div className="card-head">
            <span>{s.date}</span>
            <span className="muted">{s.mood ? `${s.mood}/10` : ''}</span>
          </div>
          <p className="card-summary">{s.summary}</p>
        </div>
      ))}
    </div>
  )
}
