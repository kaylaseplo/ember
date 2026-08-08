import React, { useEffect, useState } from 'react'

// Admin-only cost dashboard, reached via the #admin hash. The API 404s for
// anyone who isn't the ADMIN_EMAIL account, so non-admins see nothing here.
// Deliberately plain and dense — it's a dashboard, not a designed page.

const usd = (v) => (v == null ? '—' : `$${Number(v).toFixed(4)}`)
const num = (v) => (v == null ? '—' : Math.round(Number(v)).toLocaleString())
const pct = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`)

const cellStyle = { padding: '3px 10px 3px 0', textAlign: 'left', whiteSpace: 'nowrap' }
const tableStyle = { borderCollapse: 'collapse', fontSize: '0.82rem', width: '100%' }

function Table({ head, rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={tableStyle}>
        <thead>
          <tr>{head.map((h) => <th key={h} style={{ ...cellStyle, opacity: 0.6, fontWeight: 500 }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} style={cellStyle}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="card static" style={{ marginBottom: 12 }}>
      <div className="card-head"><strong>{title}</strong></div>
      {children}
    </div>
  )
}

export default function Admin() {
  const [data, setData] = useState(undefined)

  useEffect(() => {
    fetch('/api/admin/costs')
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
  }, [])

  if (data === undefined) return <div className="card static">Loading…</div>
  if (data === null) return <div className="card static">Nothing here.</div>

  const t = data.totals || {}
  const cc = data.costPerConversation || {}
  const tk = data.tokensPerConversation || {}

  return (
    <div style={{ padding: '4px 0' }}>
      <Section title="Spend">
        <Table
          head={['today', 'this week', 'this month', 'user limit/day', 'global limit/day']}
          rows={[[usd(t.today), usd(t.week), usd(t.month),
            `$${data.limits?.userDaily}`, `$${data.limits?.globalDaily}`]]}
        />
      </Section>

      <Section title="Cache hit rate (chat)">
        <div style={{ fontSize: '1.4rem' }}>{pct(data.cacheHitRate)}</div>
        <div className="card-summary">cache-read tokens as a share of all input-side tokens</div>
      </Section>

      <Section title="This month by job type">
        <Table head={['job', 'calls', 'cost']}
          rows={(data.byJobType || []).map((r) => [r.job_type, r.calls, usd(r.cost)])} />
      </Section>

      <Section title="This month by model">
        <Table head={['model', 'calls', 'cost']}
          rows={(data.byModel || []).map((r) => [r.model, r.calls, usd(r.cost)])} />
      </Section>

      <Section title="Per conversation">
        <Table
          head={['avg cost', 'median', 'p90', 'avg in tokens', 'avg out', 'avg cache read', 'avg turns']}
          rows={[[usd(cc.avg), usd(cc.median), usd(cc.p90),
            num(tk.input), num(tk.output), num(tk.cache_read),
            data.avgTurnsPerConversation == null ? '—' : Number(data.avgTurnsPerConversation).toFixed(1)]]}
        />
      </Section>

      <Section title="Per-user cost this month">
        <Table head={['email', 'calls', 'cost']}
          rows={(data.perUserMonthly || []).map((r) => [r.email, r.calls, usd(r.cost)])} />
      </Section>

      <Section title="20 most expensive calls">
        <Table
          head={['when', 'user', 'job', 'model', 'in', 'out', 'cache rd', 'cache wr', 'cost', 'ms', 'flags']}
          rows={(data.topCalls || []).map((r) => [
            new Date(r.created_at).toLocaleString(), r.user_id ?? '—', r.job_type, r.model,
            num(r.input_tokens), num(r.output_tokens), num(r.cache_read_tokens),
            num(r.cache_creation_tokens), usd(r.estimated_cost_usd), r.duration_ms ?? '—',
            [r.interrupted && 'interrupted', r.batch && 'batch'].filter(Boolean).join(', ') || '—',
          ])}
        />
      </Section>
    </div>
  )
}
