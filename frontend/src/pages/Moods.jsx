import React, { useEffect, useState } from 'react'
import { getMoods } from '../api.js'

function MoodChart({ entries }) {
  const w = 320, h = 160, pad = 24
  const n = entries.length
  const x = i => n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1)
  const y = mood => h - pad - ((mood - 1) * (h - 2 * pad)) / 9
  const points = entries.map((e, i) => `${x(i)},${y(e.mood)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mood-chart" role="img"
         aria-label="Mood over time">
      {[1, 5, 10].map(v => (
        <g key={v}>
          <line x1={pad} x2={w - pad} y1={y(v)} y2={y(v)} className="gridline" />
          <text x={4} y={y(v) + 4} className="axis-label">{v}</text>
        </g>
      ))}
      {n > 1 && <polyline points={points} className="mood-line" fill="none" />}
      {entries.map((e, i) => (
        <circle key={i} cx={x(i)} cy={y(e.mood)} r="4" className="mood-dot">
          <title>{`${e.date}: ${e.mood}/10`}</title>
        </circle>
      ))}
    </svg>
  )
}

export default function Moods() {
  const [data, setData] = useState(null)
  useEffect(() => { getMoods().then(setData).catch(() => setData({ entries: [] })) }, [])

  if (!data) return <div className="page"><p className="muted">Loading…</p></div>
  const { entries, average, trend } = data

  return (
    <div className="page">
      <h2>Mood over time</h2>
      {entries.length === 0 ? (
        <p className="muted">No mood ratings yet — rate your mood when ending a chat.</p>
      ) : (
        <>
          <MoodChart entries={entries} />
          <div className="stats">
            <div className="stat"><span className="stat-num">{average}</span><span className="muted">average</span></div>
            <div className="stat"><span className="stat-num">{entries.length}</span><span className="muted">sessions</span></div>
            {trend && <div className="stat"><span className="stat-num">{{ improving: '↗', dipping: '↘', steady: '→' }[trend]}</span><span className="muted">{trend}</span></div>}
          </div>
          <ul className="mood-list">
            {[...entries].reverse().map(e => (
              <li key={e.id}>
                <span className="muted">{e.date}</span>
                <span className="mood-bar">
                  <span className="mood-fill" style={{ width: `${e.mood * 10}%` }} />
                </span>
                <span>{e.mood}/10</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
