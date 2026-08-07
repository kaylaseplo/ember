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

export async function getMe() {
  const res = await fetch('/api/auth/me')
  if (!res.ok) return null
  const data = await res.json()
  return data.user
}

async function authPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || "Something went wrong — try again in a moment.")
  return data.user
}

export const login = (email, password) => authPost('/api/auth/login', { email, password })
export const signup = (email, password, inviteCode) =>
  authPost('/api/auth/signup', { email, password, inviteCode })
export const logout = () => fetch('/api/auth/logout', { method: 'POST' })
export const completeOnboarding = () =>
  fetch('/api/onboarding/complete', { method: 'POST' }).catch(() => {})

export async function streamChat(messages, conversationId, onChunk) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, conversationId }),
  })
  checkAuth(res)
  if (!res.ok) throw new Error(`chat failed (${res.status})`)
  const newConversationId = Number(res.headers.get('X-Conversation-Id')) || conversationId
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
  return { reply: full, conversationId: newConversationId }
}

export async function getOpenConversation() {
  const res = await fetch('/api/conversations/open')
  checkAuth(res)
  if (!res.ok) return null
  const data = await res.json()
  return data.conversation
}

export async function endSession(conversationId, mood) {
  const res = await fetch('/api/end-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, mood }),
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
