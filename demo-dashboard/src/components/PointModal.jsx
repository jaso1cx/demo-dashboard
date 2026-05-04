import React, { useMemo } from 'react'

function fmt(v, unit = '', digits = 1) {
  if (v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(digits)}${unit}`
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

export default function PointModal({ open, onClose, row }) {
  const s = row?.__stats || row?.stats || {}
  const container = useMemo(() => ({
    position: 'fixed',
    inset: 0,
    background: open ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0)',
    pointerEvents: open ? 'auto' : 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10060,
    transition: 'background 120ms ease-out'
  }), [open])

  if (!open) return <div style={container} />

  return (
    <div style={container} onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: '92vw',
          background: '#FFFFFF',
          borderRadius: 16,
          border: '1px solid #e5e7eb',
          boxShadow: '0 18px 60px rgba(0,0,0,0.18)',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 12
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <div style={{ fontWeight: 950, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row?.provider || 'Unknown provider'}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 700 }}>{fmtDate(row?.timestamp)}</div>
          </div>
          <button
            onClick={onClose}
            style={{
              border: '1px solid #d1d5db',
              borderRadius: 10,
              background: '#FFFFFF',
              padding: '8px 10px',
              cursor: 'pointer',
              fontWeight: 900
            }}
          >
            Close
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 10 }}>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 800 }}>Down</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: '#111827' }}>{fmt(s?.down ?? s?.down_mbps, ' Mbps', 1)}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 800 }}>Up</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: '#111827' }}>{fmt(s?.up ?? s?.up_mbps, ' Mbps', 1)}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 800 }}>Ping</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: '#111827' }}>{fmt(s?.ping ?? s?.ping_ms, ' ms', 0)}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 800 }}>Jitter</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: '#111827' }}>{fmt(s?.jitter ?? s?.jitter_ms, ' ms', 0)}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 800 }}>Loss</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: '#111827' }}>{fmt(s?.loss ?? s?.loss_pct, ' %', 1)}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 800 }}>Conn</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: '#111827' }}>{row?.__conn || row?.conn_tag || '—'}</div>
          </div>
{/*ADDED UI FOR NEW PLACEHOLDERS*/}
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 800 }}>Usability</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: '#111827' }}>{fmt(row?.stats?.usability_p ?? 0, 'min', 1)}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 800 }}>Persistence</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: '#111827' }}>{fmt(row?.stats?.persistence_p ?? 0, 'min', 1)}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 800 }}>Variability</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: '#111827' }}>{fmt(row?.stats?.variability_p ?? 0, 'Mbps', 1)}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 800 }}>Resilience</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: '#111827' }}>{fmt(row?.stats?.resilience_p ?? 0, 'min', 1)}</div>
          </div>
        </div>

        <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 750 }}>
          lat: {Number.isFinite(row?.lat) ? row.lat.toFixed(6) : '—'} &nbsp; lon: {Number.isFinite(row?.lon) ? row.lon.toFixed(6) : '—'}
        </div>

        {row?.group_id ? (
          <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 750 }}>
            group_id: {row.group_id}
          </div>
        ) : null}
      </div>
    </div>
  )
}
