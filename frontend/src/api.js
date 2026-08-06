// Thin client for the backend API. The server holds the Anthropic key;
// the frontend never touches it.

export async function streamChat(messages, onChunk) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
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
  if (!res.ok) throw new Error(`save failed (${res.status})`)
  return res.json()
}

export const getConversations = () => fetch('/api/conversations').then(r => r.json())
export const getConversation = (id) => fetch(`/api/conversations/${id}`).then(r => r.json())
export const getMoods = () => fetch('/api/moods').then(r => r.json())
export const getSummaries = () => fetch('/api/summaries').then(r => r.json())
