import React, { useEffect, useMemo, useState } from 'react'
import {
  getSummaries, getConversations, getTherapySessions, addTherapySession,
  getDigests, generateDigest,
} from '../api.js'

const iso = (d) => d.toISOString().slice(0, 10)
const daysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return iso(d)
}

// Minimal renderer for the digest's "## Heading" + paragraph structure.
function DigestText({ text }) {
  const blocks = text.split(/\n{2,}/)
  return (
    <>
      {blocks.map((b, i) =>
        b.startsWith('## ') ? (
          <h3 key={i}>{b.slice(3)}</h3>
        ) : (
          <p key={i} className="summary-text prewrap">{b}</p>
        )
      )}
    </>
  )
}

function DigestView({ digest, streamingText, onBack }) {
  const [copied, setCopied] = useState(false)
  const text = streamingText ?? digest?.content ?? ''

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable — quietly do nothing */ }
  }

  return (
    <div className="digest">
      <div className="digest-head">
        <button className="ghost back" onClick={onBack}>← Back</button>
        {text && streamingText === undefined && (
          <button className="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        )}
      </div>
      {digest && (
        <p className="muted">{digest.rangeStart} to {digest.rangeEnd}</p>
      )}
      <DigestText text={text} />
      {streamingText !== undefined && <p className="muted typing">…</p>}
    </div>
  )
}

export default function Summaries() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)

  const [conversations, setConversations] = useState([])
  const [therapyDates, setTherapyDates] = useState([])
  const [digests, setDigests] = useState([])

  const [preset, setPreset] = useState(null) // 'last' | 7 | 14 | 30 | 'custom'
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState(iso(new Date()))
  const [newTherapyDate, setNewTherapyDate] = useState('')
  const [savingDate, setSavingDate] = useState(false)

  const [viewing, setViewing] = useState(null) // a stored digest being read
  const [streamText, setStreamText] = useState(undefined) // in-progress generation
  const [genMessage, setGenMessage] = useState(null)

  useEffect(() => {
    getSummaries().then(setData).catch(() => setError(true))
    getConversations().then(setConversations).catch(() => {})
    getTherapySessions().then(setTherapyDates).catch(() => {})
    getDigests().then(setDigests).catch(() => {})
  }, [])

  const range = useMemo(() => {
    const end = iso(new Date())
    if (preset === 'last' && therapyDates.length > 0) {
      return { start: therapyDates[0].date, end }
    }
    if (preset === 7) return { start: daysAgo(7), end }
    if (preset === 14) return { start: daysAgo(14), end }
    if (preset === 30) return { start: daysAgo(30), end }
    if (preset === 'custom' && customStart && customEnd && customStart <= customEnd) {
      return { start: customStart, end: customEnd }
    }
    return null
  }, [preset, therapyDates, customStart, customEnd])

  const sessionsInRange = useMemo(() => {
    if (!range) return 0
    return conversations.filter((c) => {
      const d = c.date.slice(0, 10)
      return d >= range.start && d <= range.end
    }).length
  }, [range, conversations])

  const rangeDays = range
    ? Math.round((new Date(range.end) - new Date(range.start)) / 86400000)
    : 0

  async function saveTherapyDate() {
    if (!newTherapyDate || savingDate) return
    setSavingDate(true)
    try {
      await addTherapySession(newTherapyDate)
      setTherapyDates(await getTherapySessions())
      setNewTherapyDate('')
    } catch { /* quiet */ } finally {
      setSavingDate(false)
    }
  }

  async function generate() {
    if (!range || streamText !== undefined) return
    setGenMessage(null)
    setViewing(null)
    setStreamText('')
    try {
      await generateDigest(range.start, range.end, setStreamText)
      const fresh = await getDigests()
      setDigests(fresh)
      const stored = fresh.find((d) => d.rangeStart === range.start && d.rangeEnd === range.end)
      setViewing(stored || null)
      setStreamText(undefined)
      if (!stored) setGenMessage("Couldn't save that one — try again in a moment.")
    } catch (e) {
      setStreamText(undefined)
      setGenMessage(e.message)
    }
  }

  if (error) return <div className="page"><p className="muted">Couldn't load insights.</p></div>
  if (!data) return <div className="page"><p className="muted">Looking for patterns across your sessions…</p></div>

  if (streamText !== undefined || viewing) {
    return (
      <div className="page">
        <DigestView
          digest={viewing}
          streamingText={streamText}
          onBack={() => { setViewing(null); setStreamText(undefined) }}
        />
      </div>
    )
  }

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

      <h3>Prepare for a session</h3>
      <p className="muted">A digest across a stretch of sessions, to read before an appointment.</p>

      <div className="preset-row">
        {therapyDates.length > 0 && (
          <button className={`preset ${preset === 'last' ? 'active' : ''}`}
                  onClick={() => setPreset('last')}>
            Since my last session
          </button>
        )}
        <button className={`preset ${preset === 7 ? 'active' : ''}`} onClick={() => setPreset(7)}>Past week</button>
        <button className={`preset ${preset === 14 ? 'active' : ''}`} onClick={() => setPreset(14)}>Past two weeks</button>
        <button className={`preset ${preset === 30 ? 'active' : ''}`} onClick={() => setPreset(30)}>Past month</button>
        <button className={`preset ${preset === 'custom' ? 'active' : ''}`} onClick={() => setPreset('custom')}>Custom</button>
      </div>

      {preset === 'custom' && (
        <div className="date-row">
          <input type="date" value={customStart} max={customEnd}
                 onChange={e => setCustomStart(e.target.value)} aria-label="Start date" />
          <span className="muted">to</span>
          <input type="date" value={customEnd} min={customStart}
                 onChange={e => setCustomEnd(e.target.value)} aria-label="End date" />
        </div>
      )}

      {range && (
        <div className="gen-row">
          {rangeDays > 14 && (
            <p className="muted">This range covers {sessionsInRange} session{sessionsInRange === 1 ? '' : 's'}.</p>
          )}
          <button className="primary" onClick={generate} disabled={!range}>
            Generate digest
          </button>
        </div>
      )}
      {genMessage && <p className="muted gen-message">{genMessage}</p>}

      <div className="therapy-date">
        <p className="muted">
          {therapyDates.length > 0
            ? `Last therapy session recorded: ${therapyDates[0].date}`
            : 'Record when you had therapy to unlock "Since my last session".'}
        </p>
        <div className="date-row">
          <input type="date" value={newTherapyDate} max={iso(new Date())}
                 onChange={e => setNewTherapyDate(e.target.value)}
                 aria-label="Therapy session date" />
          <button className="ghost" onClick={saveTherapyDate}
                  disabled={!newTherapyDate || savingDate}>
            I had therapy on this date
          </button>
        </div>
      </div>

      {digests.length > 0 && (
        <>
          <h3>Past digests</h3>
          {digests.map(d => (
            <button key={d.id} className="card" onClick={() => setViewing(d)}>
              <div className="card-head">
                <span>{d.rangeStart} to {d.rangeEnd}</span>
                <span className="muted">{d.createdAt.slice(0, 10)}</span>
              </div>
              <p className="card-summary">{d.content.replace(/^## .*$/m, '').trim().slice(0, 110)}…</p>
            </button>
          ))}
        </>
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
