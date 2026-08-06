// Thin client for the backend API. The server holds the Anthropic key;
// the frontend never touches it.

// A 401 mid-session means the cookie expired — tell the app to show the lock
// screen (it keeps the chat mounted so nothing typed is lost).
function checkAuth(res) {
  if (res.status === 401) {
    window.dispatchEvent(new Event('ember:locked'))
    throw new Error('locked')
  }
  return res
}

export async function getSession() {
  const res = await fetch('/api/session')
  if (!res.ok) return false
  const data = await res.json()
  return !!data.authenticated
}

export async function login(passcode) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode }),
  })
  if (res.status === 429) throw new Error('Too many tries — wait a few minutes.')
  return res.ok
}

export const logout = () => fetch('/api/logout', { method: 'POST' })

export async function streamChat(messages, onChunk) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
  checkAuth(res)
  if (!res.ok) throw new Error(`chat failed (${res.status})`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    full += text
    onChunk(full)
  }
  return full
}

export async function endSession(messages, mood) {
  const res = await fetch('/api/end-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, mood }),
  })
  checkAuth(res)
  if (!res.ok) throw new Error(`save failed (${res.status})`)
  return res.json()
}

const getJson = (url) => fetch(url).then(checkAuth).then(r => r.json())

export const getConversations = () => getJson('/api/conversations')
export const getConversation = (id) => getJson(`/api/conversations/${id}`)
export const getMoods = () => getJson('/api/moods')
export const getSummaries = () => getJson('/api/summaries')
