import React, { useState } from 'react'

function Coal() {
  return (
    <svg viewBox="0 0 128 128" className="lock-icon" aria-hidden="true">
      <defs>
        <radialGradient id="obGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FE7133" stopOpacity="0.7" />
          <stop offset="55%" stopColor="#F75629" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#F75629" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="obCoal" cx="42%" cy="38%" r="70%">
          <stop offset="0%" stopColor="#FFA36B" />
          <stop offset="55%" stopColor="#FE7133" />
          <stop offset="100%" stopColor="#D63C23" />
        </radialGradient>
      </defs>
      <circle cx="64" cy="64" r="52" fill="url(#obGlow)" />
      <circle cx="64" cy="64" r="22" fill="url(#obCoal)" />
    </svg>
  )
}

const SCREENS = [
  {
    coal: true,
    title: 'This is Ember',
    body: (
      <>
        <p>
          Ember is a place to think out loud between therapy sessions. It
          listens, asks questions, and remembers what you've told it.
        </p>
        <p className="ob-notice">
          Ember is not a therapist, and it is not a substitute for professional
          care. If you are in crisis, contact a crisis line or emergency
          services. In the US, call or text 988.
        </p>
      </>
    ),
  },
  {
    title: 'Chat and Entries',
    body: (
      <>
        <p>Chat is the conversation. Say whatever is on your mind.</p>
        <p>
          When you're done, press End. That's when Ember asks how you're
          feeling and saves the session.
        </p>
        <p>Saved sessions live in Entries, where you can reread any of them.</p>
      </>
    ),
  },
  {
    title: 'Moods and Insights',
    body: (
      <>
        <p>
          Moods shows your ratings over time, so you can see how a stretch of
          weeks actually went rather than guessing.
        </p>
        <p>Insights surfaces themes that keep coming up across sessions.</p>
        <p>Both are useful to look at before a therapy appointment.</p>
      </>
    ),
  },
  {
    title: 'Your data',
    body: (
      <>
        <p>Your entries are private to your account. Nobody else can read them.</p>
        <p>There's nothing you have to write about. Start wherever you are.</p>
      </>
    ),
  },
]

export default function Onboarding({ onDone }) {
  const [step, setStep] = useState(0)
  const screen = SCREENS[step]
  const last = step === SCREENS.length - 1

  return (
    <div className="onboarding">
      <div className="ob-body">
        {screen.coal && <Coal />}
        <h2>{screen.title}</h2>
        {screen.body}
      </div>

      <div className="ob-controls">
        <div className="ob-dots" aria-hidden="true">
          {SCREENS.map((_, i) => (
            <span key={i} className={`ob-dot ${i === step ? 'active' : ''}`} />
          ))}
        </div>
        <div className="ob-buttons">
          {step > 0 && (
            <button className="ghost" onClick={() => setStep(s => s - 1)}>Back</button>
          )}
          {last ? (
            <button className="primary" onClick={onDone}>Begin</button>
          ) : (
            <button className="primary" onClick={() => setStep(s => s + 1)}>Next</button>
          )}
        </div>
        {!last && (
          <button className="link ob-skip" onClick={onDone}>Skip</button>
        )}
      </div>
    </div>
  )
}
