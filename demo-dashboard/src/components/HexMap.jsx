// HexMap.jsx (OLD UI + wiring, NEW backend fetch)
//
// Backend endpoint assumed:
//   GET /api/map/points?bbox=west,south,east,north&limit=20000
// returns:
//   { points: [ { id, group_id, provider, conn_tag, timestamp, lat, lon,
//                tests:{download:{mbps}, upload:{mbps}, latency:{rtt_ms,jitter_ms,loss_pct}} } ] }

import React, { useEffect, useRef, useState, useMemo } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import * as h3 from 'h3-js'
import { apiGet } from '../utils/api'

const HEX_RES = 8
const HEX_ZOOM_MIN = 9.0
const HEX_ZOOM_MAX = 14.0
const HEX_MAX_CELLS = 6000

const MAX_FETCH = 20000

const PALETTE = {
  green: '#1E5638',
  greenLight: '#C8E3CC',
  greenDark: '#003618',
  blue: '#1D4ED8',
  blueLight: '#DBEAFE',
  blueDark: '#0B2C8A',
  orange: '#EA580C',
  orangeLight: '#FFE7D6',
  orangeDark: '#9A3606',
  grey: '#777777',
  greyDark: '#464646',
  greyLight: '#BABABA',
  white: '#FFFFFF',
  black: '#000000'
}

const TYPE_COLORS = {
  upload: { badgeBg: PALETTE.greenLight, badgeText: PALETTE.greenDark, tintBg: PALETTE.greenLight, tintBorder: PALETTE.green, bubble: PALETTE.greenDark, outline: PALETTE.greenDark, fill: PALETTE.green },
  download: { badgeBg: PALETTE.blueLight, badgeText: PALETTE.blueDark, tintBg: PALETTE.blueLight, tintBorder: PALETTE.blue, bubble: PALETTE.blueDark, outline: PALETTE.blueDark, fill: PALETTE.blue },
  latency: { badgeBg: PALETTE.orangeLight, badgeText: PALETTE.orangeDark, tintBg: PALETTE.orangeLight, tintBorder: PALETTE.orange, bubble: PALETTE.orangeDark, outline: PALETTE.orangeDark, fill: PALETTE.orange },
  default: { badgeBg: PALETTE.greyLight, badgeText: PALETTE.greyDark, tintBg: PALETTE.greyLight, tintBorder: PALETTE.grey, bubble: PALETTE.greyDark, outline: PALETTE.greyDark, fill: PALETTE.grey }
}

const emptyFC = () => ({ type: 'FeatureCollection', features: [] })

function safeSetGeoJSON(map, sourceId, fc) {
  if (!map) return
  const src = map.getSource(sourceId)
  if (!src || typeof src.setData !== 'function') return
  try { src.setData(fc) } catch {}
}

function setVis(map, layerId, visible) {
  if (!map || !map.getLayer || !map.getLayer(layerId)) return
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
}

function viewportLoops(map) {
  const b = map.getBounds()
  const west = b.getWest(), east = b.getEast(), south = b.getSouth(), north = b.getNorth()
  const makeLoop = (S, W, N, E) => ([[S, W], [N, W], [N, E], [S, E], [S, W]])
  if (west <= east) return [makeLoop(south, west, north, east)]
  return [makeLoop(south, west, north, 180), makeLoop(south, -180, north, east)]
}

function polygonToCellsCompat(inputRing, res) {
  let ring = inputRing
  if (Array.isArray(ring) && Array.isArray(ring[0]) && Array.isArray(ring[0][0])) ring = ring[0]
  if (!Array.isArray(ring)) return []
  const toLatLng = (p) => {
    if (!p) return null
    if (Array.isArray(p)) {
      const a = Number(p[0]), b = Number(p[1])
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null
      if (Math.abs(a) <= 180 && Math.abs(b) <= 90 && (Math.abs(a) > 90 || Math.abs(b) > 90)) return [b, a]
      return [a, b]
    }
    if (typeof p === 'object') {
      if ('lat' in p && 'lng' in p) return [Number(p.lat), Number(p.lng)]
      if ('latitude' in p && 'longitude' in p) return [Number(p.latitude), Number(p.longitude)]
    }
    return null
  }
  let ringLatLng = ring.map(toLatLng).filter(Boolean)
  if (ringLatLng.length < 3) return []
  const [fLat, fLng] = ringLatLng[0]
  const [lLat, lLng] = ringLatLng[ringLatLng.length - 1]
  if (fLat !== lLat || fLng !== lLng) ringLatLng = [...ringLatLng, ringLatLng[0]]
  return h3.polygonToCells([ringLatLng], res) || []
}

function shouldRenderHexes(map) {
  const z = map.getZoom()
  return z >= HEX_ZOOM_MIN && z <= HEX_ZOOM_MAX
}

function buildViewportHexOutlines(map) {
  const loops = viewportLoops(map)
  let cells = []
  try { cells = loops.flatMap(lp => polygonToCellsCompat(lp, HEX_RES)) } catch { cells = [] }
  const MAX = Math.max(HEX_MAX_CELLS, 20000)
  if (cells.length > MAX) return { ...emptyFC(), _cells: [] }
  const features = []
  for (const idx of cells) {
    const ringLngLat = h3.cellToBoundary(idx, true)
    features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ringLngLat, ringLngLat[0]]] }, properties: { idx } })
  }
  return { type: 'FeatureCollection', features, _cells: cells }
}

function normalizeProviderBucket(provider) {
  const p = String(provider || '').toLowerCase()
  if (p.includes('att') || p.includes('at&t')) return 'AT&T'
  if (p.includes('t-mobile') || p.includes('tmobile')) return 'T-Mobile'
  if (p.includes('verizon')) return 'Verizon'
  return 'Other'
}

function extractStats(row) {
  const toNum = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  // Prefer the normalized "tests" shape, but fall back to backend "stats"
  const down =
    toNum(row?.tests?.download?.mbps) ??
    toNum(row?.stats?.down_mbps) ??
    toNum(row?.stats?.dl_mbps)

  const up =
    toNum(row?.tests?.upload?.mbps) ??
    toNum(row?.stats?.up_mbps) ??
    toNum(row?.stats?.ul_mbps)

  const ping =
    toNum(row?.tests?.latency?.ping_ms) ??
    toNum(row?.tests?.latency?.ping) ??
    toNum(row?.tests?.latency?.rtt_ms) ??
    toNum(row?.stats?.ping_ms) ??
    toNum(row?.stats?.rtt)

  const jitter =
    toNum(row?.tests?.latency?.jitter_ms) ??
    toNum(row?.stats?.jitter_ms) ??
    toNum(row?.stats?.jitter)

  const loss =
    toNum(row?.tests?.latency?.loss_pct) ??
    toNum(row?.stats?.loss_pct)

  return { down, up, ping, jitter, loss }
}


function aggNums(arr) {
  const vals = arr.filter(v => Number.isFinite(Number(v))).map(Number)
  if (!vals.length) return { avg: null, min: null, max: null }
  const sum = vals.reduce((a, b) => a + b, 0)
  return { avg: sum / vals.length, min: Math.min(...vals), max: Math.max(...vals) }
}

function inferKindFromStats(s) {
  const hasDown = s?.down != null
  const hasUp = s?.up != null
  const hasLat = s?.ping != null || s?.jitter != null || s?.loss != null
  if (hasLat && !hasDown && !hasUp) return 'latency'
  if (hasDown && !hasUp && !hasLat) return 'download'
  if (hasUp && !hasDown && !hasLat) return 'upload'
  return 'default'
}

function dominantTypeFromFilters(typeFilters) {
  if (typeFilters?.all) return null
  const enabled = ['upload', 'download', 'latency'].filter(k => typeFilters?.[k]?.enabled)
  if (enabled.length === 1) return enabled[0]
  return null
}

function dominantTypeOfItems(items, typeFilters) {
  const forced = dominantTypeFromFilters(typeFilters)
  if (forced) return forced
  const counts = { upload: 0, download: 0, latency: 0 }
  for (const it of items || []) {
    const s = it?.__stats || extractStats(it)
    const k = inferKindFromStats(s)
    if (k === 'upload') counts.upload++
    else if (k === 'download') counts.download++
    else if (k === 'latency') counts.latency++
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const [topType, topCount] = entries[0] || []
  if (!topCount) return 'default'
  return topType
}

function buildSheetData(hexIdx, itemsRaw, typeFilters) {
  const items = (itemsRaw || []).map(m => ({ ...m, __stats: m.__stats || extractStats(m) }))
  const downs = items.map(i => i.__stats.down)
  const ups = items.map(i => i.__stats.up)
  const pings = items.map(i => i.__stats.ping)
  const jits = items.map(i => i.__stats.jitter)
  const losses = items.map(i => i.__stats.loss)

  const usability = items.map(i => i?.stats?.usability_p)
  const persistence = items.map(i => i?.stats?.persistence_p)
  const variability = items.map(i => i?.stats?.variability_p)
  const resilience = items.map(i => i?.stats?.resilience_p)
//Updated buildSheetData to include new stats
  const summary = { count: items.length, down: aggNums(downs), up: aggNums(ups), ping: aggNums(pings), jitter: aggNums(jits), loss: aggNums(losses), 
  usability_p: aggNums(usability), persistence_p: aggNums(persistence), variability_p: aggNums(variability), resilience_p: aggNums(resilience) }
  
  const domType = dominantTypeOfItems(items, typeFilters)
  return { hexIdx, summary, items, domType }
}

function rowsToPointFeatures(rows) {
  const features = []
  for (const r of rows || []) {
    const lat = Number(r?.lat)
    const lon = Number(r?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        id: r.id,
        ts: r.timestamp,
        provider: r.provider,
        type: r.type,
        count: 1
      }
    })
  }
  return { type: 'FeatureCollection', features }
}


function applySelectionColors(map, dominantType) {
  if (!map) return
  const kind = dominantType || 'default'
  const c = TYPE_COLORS[kind] || TYPE_COLORS.default
  if (map.getLayer('hex-selected-outline')) map.setPaintProperty('hex-selected-outline', 'line-color', c.outline)
  if (map.getLayer('hex-selected-fill')) map.setPaintProperty('hex-selected-fill', 'fill-color', c.fill)
  if (map.getLayer('hex-selected-label')) {
    map.setPaintProperty('hex-selected-label', 'text-color', PALETTE.white)
    map.setPaintProperty('hex-selected-label', 'text-halo-color', PALETTE.greenDark)
    map.setPaintProperty('hex-selected-label', 'text-halo-width', 1.5)
  }
}

function RightPanel({ open, onClose, data, width = 420 }) {
  const hexIdx = data?.hexIdx ?? ''
  const initialLocName = typeof data?.locationName === 'string' && data.locationName.trim()
    ? data.locationName.trim()
    : null

  const [locName, setLocName] = React.useState(initialLocName)
  const [shortName, setShortName] = React.useState(initialLocName || 'Selected area')

  const summary = data?.summary ?? {
    count: 0,
    down: { avg: null, min: null, max: null },
    up: { avg: null, min: null, max: null },
    ping: { avg: null, min: null, max: null },
    jitter: { avg: null, min: null, max: null },
    loss: { avg: null, min: null, max: null }
  }
  const items = Array.isArray(data?.items) ? data.items : []

  const shortenPlaceName = React.useCallback((name, maxChars = 42) => {
    if (!name) return 'Selected area'
    const raw = name.replace(/\s+/g, ' ').trim()
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
    const bannedTail = /^(united states|usa|canada|mexico|europe|asia|africa|australia|antarctica)$/i
    while (parts.length > 2 && bannedTail.test(parts[parts.length - 1])) parts.pop()

    let picked = parts.slice(0, 2)
    if (picked[0] && picked[1] && picked[0].toLowerCase() === picked[1].toLowerCase()) picked = [picked[0]]

    let candidate = picked.join(', ')
    if (candidate.length <= maxChars) return candidate

    candidate = picked[0] || raw
    if (candidate.length <= maxChars) return candidate

    const CUT = Math.max(0, maxChars - 1)
    return candidate.slice(0, CUT) + '…'
  }, [])

  React.useEffect(() => {
    let aborted = false
    async function resolveName() {
      try {
        if (initialLocName) {
          if (!aborted) {
            setLocName(initialLocName)
            setShortName(shortenPlaceName(initialLocName))
          }
          return
        }
        if (!hexIdx) {
          if (!aborted) {
            setLocName('Selected area')
            setShortName('Selected area')
          }
          return
        }

        const [lat, lng] = h3.cellToLatLng(hexIdx)
        const token = import.meta.env.VITE_MAPBOX_TOKEN
        if (!token || lat == null || lng == null) {
          if (!aborted) {
            setLocName('Selected area')
            setShortName('Selected area')
          }
          return
        }

        const url =
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
          `?access_token=${token}&limit=1&types=place,locality,neighborhood,poi,address,region,postcode`

        const resp = await fetch(url)
        const json = await resp.json()
        const name = json?.features?.[0]?.place_name || json?.features?.[0]?.text || null

        if (!aborted) {
          const full = name || 'Selected area'
          setLocName(full)
          setShortName(shortenPlaceName(full))
        }
      } catch {
        if (!aborted) {
          setLocName('Selected area')
          setShortName('Selected area')
        }
      }
    }
    resolveName()
    return () => { aborted = true }
  }, [hexIdx, initialLocName, shortenPlaceName])

  const fmt = (v, unit = '', digits = 1) => (v == null ? '—' : `${Number(v).toFixed(digits)}${unit}`)
  const fmtDate = (ts) => {
    if (!ts) return '—'
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString()
  }

  const statRow = (k, v) => (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
      <div style={{ fontSize: 12, color: '#6B7280' }}>{k}</div>
      <div style={{ fontSize: k === 'Average' ? 20 : 13, fontWeight: k === 'Average' ? 700 : 600, color: '#111827' }}>
        {v}
      </div>
    </div>
  )

  const statCard = (label, obj, unit = '', digits = 1) => {
    const fmtNum = (n) => (n == null ? '—' : `${Number(n).toFixed(digits)}${unit}`)
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        background: '#F8FAFC', border: '1px solid #E5E7EB',
        borderRadius: 10, padding: 12, minWidth: 160
      }}>
        <div style={{ fontSize: 12, color: '#6B7280' }}>{label}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {statRow('Average', fmtNum(obj?.avg))}
          {statRow('Min', fmtNum(obj?.min))}
          {statRow('Max', fmtNum(obj?.max))}
        </div>
      </div>
    )
  }

  const chip = (text, kind) => {
    const c = TYPE_COLORS[kind] || TYPE_COLORS.default
    return (
      <span style={{
        display: 'inline-block',
        background: c.badgeBg,
        color: c.badgeText,
        border: `1px solid ${c.tintBorder}`,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1
      }}>{text}</span>
    )
  }

  const exportPanelCsv = () => {
    const rows = Array.isArray(items) ? items : []
    const header = 'hex_idx,id,group_id,provider,conn_tag,timestamp,lat,lon,down_mbps,up_mbps,ping_ms,jitter_ms,loss_pct\n'
    const rowToCsvLine = (r) => {
      const s = r.__stats || extractStats(r)
      const vals = [
        hexIdx,
        r.id ?? '',
        r.group_id ?? '',
        r.provider ?? '',
        r.__conn ?? r.conn_tag ?? '',
        r.timestamp ?? '',
        Number.isFinite(r.lat) ? r.lat : '',
        Number.isFinite(r.lon) ? r.lon : '',
        s?.down ?? '',
        s?.up ?? '',
        s?.ping ?? '',
        s?.jitter ?? '',
        s?.loss ?? ''
      ]
      return vals.map((v) => {
        if (v == null) return ''
        const str = String(v)
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
      }).join(',')
    }

    const csv = header + rows.map(rowToCsvLine).join('\n') + (rows.length ? '\n' : '')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const when = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `cellwatch_hex_${hexIdx || 'unknown'}_${rows.length}_rows_${when}.csv`
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const container = {
    position: 'fixed', top: 0, bottom: 0, right: 0, width,
    background: '#FFFFFF',
    boxShadow: '-2px 0 24px rgba(0,0,0,0.12)',
    borderLeft: '1px solid #e5e7eb',
    zIndex: 10002,
    transform: open ? 'translateX(0)' : `translateX(${width + 24}px)`,
    transition: 'transform 180ms ease-out',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    fontFamily: 'Inter, system-ui, Arial, sans-serif'
  }

  const header = {
    position: 'sticky', top: 0, zIndex: 1,
    background: '#FFFFFF',
    borderBottom: '1px solid #eef2f7',
    padding: '12px 14px',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10
  }

  const content = { flex: 1, overflow: 'auto', padding: 14, color: '#555', fontSize: 13 }

  const leftStack = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    lineHeight: 1.2,
    gap: 4,
    minWidth: 0
  }

  const titleClamp = {
    color: '#1f2937',
    fontWeight: 700,
    fontSize: 16,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    maxWidth: 260,
    lineHeight: 1.2,
    wordBreak: 'break-word'
  }

  const btn = (style = {}) => ({
    border: '1px solid #d1d5db',
    borderRadius: 8,
    background: '#FFFFFF',
    padding: '6px 10px',
    cursor: 'pointer',
    color: '#464646',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    ...style
  })

  return (
    <div style={container} aria-hidden={!open}>
      <div style={header}>
        <div style={leftStack}>
          <span style={titleClamp} title={locName || 'Selected area'}>
            {shortName || 'Selected area'}
          </span>
          <span style={{ color: '#6b7280', fontWeight: 500, fontSize: 12 }}>Hex {hexIdx}</span>
          <span style={{ color: '#6b7280', fontWeight: 500, fontSize: 12 }}>
            {summary.count} measurement{summary.count === 1 ? '' : 's'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button
            onClick={exportPanelCsv}
            style={btn({ borderColor: PALETTE.green, background: PALETTE.greenDark, color: '#FFFFFF' })}
            title="Download CSV for this hex"
          >
            Download CSV
          </button>
          <button style={btn()} onClick={onClose} title="Close panel">Close</button>
        </div>
      </div>

      <div style={content}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 10 }}>
          {statCard('Down (Mbps)', summary.down, ' Mbps', 1)}
          {statCard('Up (Mbps)', summary.up, ' Mbps', 1)}
          {statCard('Ping (ms)', summary.ping, ' ms', 0)}
          {statCard('Jitter (ms)', summary.jitter, ' ms', 0)}
          {statCard('Loss (%)', summary.loss, ' %', 1)}
{/*ADDED UI FOR USABILITY, PERSISTENCE, VARIABILITY, RESILIENCE*/}
          {statCard('Usability (%)', summary.usability_p, ' %', 1)}
          {statCard('Persistence (min)', summary.persistence_p, ' min', 1)}
          {statCard('Variability (s)', summary.variability_p, ' s', 1)}
          {statCard('Resilience (min)', summary.resilience_p, ' min', 1)}
        </div>

        <div style={{ height: 1, background: '#E5E7EB', margin: '12px 0' }} />

        {items.length === 0 ? (
          <div>No measurements in this hex (after filters).</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {items.map((m) => {
              const s = m.__stats || extractStats(m)
              const kind = inferKindFromStats(s)
              return (
                <div
                  key={`${m.id}-${m.group_id || ''}`}
                  style={{
                    border: '1px solid #E5E7EB',
                    borderRadius: 10,
                    padding: 12,
                    background: '#FFFFFF'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{
                        color: '#374151',
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: 220
                      }}>
                        {m.provider || 'Unknown provider'}
                      </span>
                    </div>
                    <div style={{ color: '#6B7280', whiteSpace: 'nowrap' }}>{fmtDate(m.timestamp)}</div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 6, marginTop: 6 }}>
                    <div><strong>Down</strong><div>{fmt(s.down, ' Mbps', 1)}</div></div>
                    <div><strong>Up</strong><div>{fmt(s.up, ' Mbps', 1)}</div></div>
                    <div><strong>Ping</strong><div>{fmt(s.ping, ' ms', 0)}</div></div>
                    <div><strong>Jitter</strong><div>{fmt(s.jitter, ' ms', 0)}</div></div>
                    <div><strong>Loss</strong><div>{fmt(s.loss, ' %', 1)}</div></div>

                    <div><strong>Usability</strong><div>{fmt(m?.stats?.usability_p, ' %', 1)}</div></div>
                    <div><strong>Persistence</strong><div>{fmt(m?.stats?.persistence_p, ' min', 1)}</div></div>
                    <div><strong>Variability</strong><div>{fmt(m?.stats?.variability_p, ' s', 1)}</div></div>
                    <div><strong>Resilience</strong><div>{fmt(m?.stats?.resilience_p, ' min', 1)}</div></div>  

                    <div><strong>Conn</strong><div>{m.__conn || m.conn_tag || '—'}</div></div>
  
  {/*ADDED UI FOR NEW PLACEHOLDERS*/}
                    
                  </div>

                  <div style={{ marginTop: 8, fontSize: 12, color: '#6B7280' }}>
                    <span style={{ marginRight: 12 }}>lat: {Number.isFinite(m.lat) ? m.lat.toFixed(5) : '—'}</span>
                    <span>lon: {Number.isFinite(m.lon) ? m.lon.toFixed(5) : '—'}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/* ======================== MAIN COMPONENT ======================== */
export default function HexMap({
  mode = 'hex',
  typeFilters = { all: true, upload: { enabled: false, mode: 'all', threshold: '' }, download: { enabled: false, mode: 'all', threshold: '' }, latency: { enabled: false, mode: 'all', threshold: '' } },
  connTypes = ['4G', '5G', 'Other'],
  providers = ['AT&T', 'T-Mobile', 'Verizon', 'Other'],
  dateRange = { preset: 'all', start: '', end: '' },
  onPointClick = () => {},
  onRegisterSearch,
  onRegisterExport
}) {
  const mapEl = useRef(null)
  const mapRef = useRef(null)

  const [rowsAll, setRowsAll] = useState([])
  const [mapReady, setMapReady] = useState(false)
  const latestRowsRef = useRef([])

  const [panelOpen, setPanelOpen] = useState(false)
  const [panelData, setPanelData] = useState(null)

  const [selectedIdx, setSelectedIdx] = useState(null)
  const selectedIdxRef = useRef(null)

  const cellItemsRef = useRef(new Map())
  const rowsAllRef = useRef([])
  const modeRef = useRef(mode)
  const [exporting, setExporting] = useState(false)
  const [viewportLoading, setViewportLoading] = useState(false)

  const rowsFilteredRef = useRef([])

  useEffect(() => { rowsAllRef.current = rowsAll }, [rowsAll])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { selectedIdxRef.current = selectedIdx }, [selectedIdx])

  const dateBounds = useMemo(() => {
    const now = new Date()
    let start = null, end = null
    switch (dateRange?.preset) {
      case '1m': { start = new Date(now); start.setMonth(start.getMonth() - 1); break }
      case '6m': { start = new Date(now); start.setMonth(start.getMonth() - 6); break }
      case '1y': { start = new Date(now); start.setFullYear(start.getFullYear() - 1); break }
      case 'custom': {
        start = dateRange?.start ? new Date(dateRange.start) : null
        end = dateRange?.end ? new Date(dateRange.end) : null
        break
      }
      case 'all':
      default: { start = null; end = null; break }
    }
    return { start, end }
  }, [dateRange])

  const typePass = (row) => {
    if (typeFilters?.all) return true
    const cfg = typeFilters || {}
    const s = row.__stats || extractStats(row)
    const thrNum = (x) => {
      const n = Number(x)
      return Number.isFinite(n) ? n : null
    }
    const check = (key) => {
      const f = cfg[key]
      if (!f?.enabled) return false
      if (f.mode === 'all' || f.threshold === '' || f.threshold == null) {
        if (key === 'upload') return s.up != null
        if (key === 'download') return s.down != null
        if (key === 'latency') return s.ping != null
        return false
      }
      const thr = thrNum(f.threshold)
      if (thr == null) return true
      if (key === 'upload') {
        if (s.up == null) return false
        return f.mode === 'above' ? s.up >= thr : s.up <= thr
      }
      if (key === 'download') {
        if (s.down == null) return false
        return f.mode === 'above' ? s.down >= thr : s.down <= thr
      }
      if (key === 'latency') {
        if (s.ping == null) return false
        return f.mode === 'above' ? s.ping >= thr : s.ping <= thr
      }
      return false
    }
    return ['upload', 'download', 'latency'].some(k => check(k))
  }

  const connPass = (row) => {
    const selected = new Set(connTypes || [])
    if (selected.size === 0) return true
    const tag = row?.__conn || row?.conn_tag || 'Other'
    return selected.has(tag)
  }

  const providerPass = (row) => {
    if (!providers?.length) return true
    const bucket = row.__providerBucket || normalizeProviderBucket(row.provider)
    return providers.includes(bucket)
  }

  const datePass = (row) => {
    if (!dateBounds.start && !dateBounds.end) return true
    const ts = row?.timestamp ? new Date(row.timestamp) : null
    if (!ts || Number.isNaN(ts.getTime())) return false
    if (dateBounds.start && ts < dateBounds.start) return false
    if (dateBounds.end && ts > dateBounds.end) return false
    return true
  }

  const rowsFiltered = useMemo(() => {
    const src = rowsAll || []
    const out = []
    for (const r of src) {
      const __stats = r.__stats || extractStats(r)
      const __providerBucket = r.__providerBucket || normalizeProviderBucket(r.provider)
      const __conn = r.__conn || r.conn_tag || 'Other'
      const rr = (r.__stats && r.__providerBucket && r.__conn) ? r : { ...r, __stats, __providerBucket, __conn }
      if (providerPass(rr) && connPass(rr) && datePass(rr) && typePass(rr)) out.push(rr)
    }
    return out
  }, [rowsAll, typeFilters, providers, connTypes, dateBounds])

  useEffect(() => {
    rowsFilteredRef.current = rowsFiltered
    latestRowsRef.current = rowsFiltered
  }, [rowsFiltered])

  function aggregateIntoHexes(rowsArg, cellIdxsSet) {
    const counts = new Map()
    const itemsByCell = new Map()
    for (const r of rowsArg || []) {
      const lat = Number(r?.lat)
      const lon = Number(r?.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      const idx = h3.latLngToCell(lat, lon, HEX_RES)
      if (!cellIdxsSet.has(idx)) continue
      counts.set(idx, (counts.get(idx) || 0) + 1)
      if (!itemsByCell.has(idx)) itemsByCell.set(idx, [])
      itemsByCell.get(idx).push(r)
    }
    const fillFeatures = []
    const centerFeatures = []
    for (const [idx, count] of counts.entries()) {
      if (count <= 0) continue
      const ring = h3.cellToBoundary(idx, true)
      fillFeatures.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, properties: { idx, count } })
      const [latC, lngC] = h3.cellToLatLng(idx)
      centerFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lngC, latC] }, properties: { idx, count } })
    }
    return { fills: { type: 'FeatureCollection', features: fillFeatures }, centers: { type: 'FeatureCollection', features: centerFeatures }, itemsByCell }
  }

  function redrawHexes(map, rowsLocal, modeLocal) {
    const gate = shouldRenderHexes(map) && modeLocal === 'hex'
    if (!gate) {
      safeSetGeoJSON(map, 'hexes', emptyFC())
      safeSetGeoJSON(map, 'hex-fills', emptyFC())
      safeSetGeoJSON(map, 'hex-centers', emptyFC())
      cellItemsRef.current = new Map()
      return
    }
    const outlinesFC = buildViewportHexOutlines(map)
    safeSetGeoJSON(map, 'hexes', outlinesFC)
    const setOfCells = new Set(outlinesFC._cells || outlinesFC.features.map(f => f.properties.idx))
    const { fills, centers, itemsByCell } = aggregateIntoHexes(rowsLocal, setOfCells)
    safeSetGeoJSON(map, 'hex-fills', fills)
    safeSetGeoJSON(map, 'hex-centers', centers)
    cellItemsRef.current = itemsByCell
    updateSelectionOverlay(map, selectedIdxRef.current)
  }

  function buildHexFeature(idx) {
    if (!idx) return emptyFC()
    const ring = h3.cellToBoundary(idx, true)
    return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, properties: { idx } }] }
  }

  function buildCenterFeature(idx, count = 0) {
    if (!idx) return emptyFC()
    const [latC, lngC] = h3.cellToLatLng(idx)
    return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lngC, latC] }, properties: { idx, count } }] }
  }

  function updateSelectionOverlay(map, idx) {
    if (!map) return
    if (!idx) {
      safeSetGeoJSON(map, 'hex-selected', emptyFC())
      safeSetGeoJSON(map, 'hex-center-selected', emptyFC())
      if (map.getLayer('hex-selected-bubble')) map.setPaintProperty('hex-selected-bubble', 'circle-radius', 18)
      applySelectionColors(map, 'default')
      return
    }
    const items = cellItemsRef.current.get(idx) ||
      (rowsFilteredRef.current || []).filter(r => h3.latLngToCell(Number(r.lat), Number(r.lon), HEX_RES) === idx)
    const count = items.length
    safeSetGeoJSON(map, 'hex-selected', buildHexFeature(idx))
    safeSetGeoJSON(map, 'hex-center-selected', buildCenterFeature(idx, count))
    if (map.getLayer('hex-selected-bubble')) map.setPaintProperty('hex-selected-bubble', 'circle-radius', 24)
    const domType = dominantTypeOfItems(items, typeFilters)
    applySelectionColors(map, domType)
  }

  function applyModeVisibility(map, currentMode) {
    if (!map) return
    const hexZoomOk = shouldRenderHexes(map)
    const wantHex = currentMode === 'hex'
    const showHex = wantHex && hexZoomOk
    const showDot = !showHex

    setVis(map, 'hex-outline', showHex)
    setVis(map, 'hex-fill-active', showHex)
    setVis(map, 'hex-count-bubble', showHex)
    setVis(map, 'hex-count-label', showHex)

    setVis(map, 'hex-selected-fill', showHex)
    setVis(map, 'hex-selected-outline', showHex)
    setVis(map, 'hex-selected-bubble', showHex)
    setVis(map, 'hex-selected-label', showHex)

    setVis(map, 'clusters', showDot)
    setVis(map, 'cluster-count', showDot)
    setVis(map, 'unclustered-point', showDot)
  }

  const openHexSheet = (idx) => {
    if (!idx) return
    const items =
      cellItemsRef.current.get(idx) ||
      (rowsFilteredRef.current || []).filter(r => h3.latLngToCell(Number(r.lat), Number(r.lon), HEX_RES) === idx)
    const payload = buildSheetData(idx, items, typeFilters)
    setPanelData(payload)
    setPanelOpen(true)
    setSelectedIdx(idx)
    updateSelectionOverlay(mapRef.current, idx)
    try {
      const [lat, lng] = h3.cellToLatLng(idx)
      mapRef.current?.flyTo({ center: [lng, lat], zoom: Math.max(mapRef.current.getZoom(), 12), speed: 0.9 })
    } catch {}
  }

  const openDotSheet = (lng, lat, clickedId) => {
    const idx = h3.latLngToCell(lat, lng, HEX_RES)
    const allInHex =
      cellItemsRef.current.get(idx) ||
      (rowsFilteredRef.current || []).filter(r => h3.latLngToCell(Number(r.lat), Number(r.lon), HEX_RES) === idx)
    const clicked = clickedId ? allInHex.find(m => m.id === clickedId) : null
    const items = clicked ? [clicked, ...allInHex.filter(m => m.id !== clicked.id)] : allInHex
    const payload = buildSheetData(idx, items, typeFilters)
    setPanelData(payload)
    setPanelOpen(true)
    setSelectedIdx(idx)
    updateSelectionOverlay(mapRef.current, idx)
  }

  async function fetchViewportRows(map) {
    setViewportLoading(true)

    const debug = (import.meta.env.VITE_DEBUG_MAP || '').toLowerCase() === 'true'

    try {
      const b = map.getBounds()
      const west = b.getWest(), east = b.getEast(), south = b.getSouth(), north = b.getNorth()
      const bbox = `${west},${south},${east},${north}`

      if (debug) {
        console.groupCollapsed('[HexMap] fetchViewportRows')
        console.log('bbox:', bbox)
        console.log('bounds:', { west, south, east, north })
        console.log('limit:', MAX_FETCH)
        console.groupEnd()
      }

      let json
      try {
        json = await apiGet('/api/map/points', { bbox, limit: MAX_FETCH })
      } catch (e) {
        console.error('[HexMap] /api/map/points failed:', e)
        return []
      }

      const points = Array.isArray(json?.points) ? json.points : []

      if (debug && points[0]) {
        console.log('[p0 keys]', Object.keys(points[0] || {}))
        console.log('[p0.stats keys]', Object.keys(points[0]?.stats || {}))
        console.log('[p0.stats json]', JSON.stringify(points[0]?.stats || {}, null, 2))
        console.log('[p0 json]', JSON.stringify(points[0] || {}, null, 2))
      }

      const mapped = points.map((p) => {
        const center = Array.isArray(p?.center) ? p.center : null
        const lon = center && center.length === 2 ? Number(center[0]) : NaN
        const lat = center && center.length === 2 ? Number(center[1]) : NaN

        const statsObj = (p?.stats && typeof p.stats === 'object') ? p.stats : {}

        const down = Number(statsObj.down_mbps ?? statsObj.dl_mbps)
        const up   = Number(statsObj.up_mbps   ?? statsObj.ul_mbps)
        const ping = Number(statsObj.ping_ms ?? statsObj.rtt_ms ?? statsObj.ping)
        const jit  = Number(statsObj.jitter_ms)
        const loss = Number(statsObj.loss_pct)
        const latency = (Number.isFinite(ping) || Number.isFinite(jit) || Number.isFinite(loss))
            ? {
                ping_ms: Number.isFinite(ping) ? ping : null,
                ping:    Number.isFinite(ping) ? ping : null,
                rtt_ms:  Number.isFinite(ping) ? ping : null,
                jitter_ms: Number.isFinite(jit)  ? jit  : null,
                loss_pct:  Number.isFinite(loss) ? loss : null,
              }
            : null

        const tests = {
          download: Number.isFinite(down) ? { mbps: down } : null,
          upload:   Number.isFinite(up)   ? { mbps: up }   : null,
          latency,
        }

        const row = {
          id: p.group_id,
          group_id: p.group_id ?? null,
          provider: p.provider ?? null,
          timestamp: p.timestamp ?? null,
          conn_tag: p.conn_tag ?? 'Other',
          lat,
          lon,

          // keep raw stats too
          stats: statsObj,
          tests,
        }

        return {
          ...row,
          __stats: extractStats(row),
          __conn: row.conn_tag ?? 'Other',
          __providerBucket: normalizeProviderBucket(row.provider),
        }
      })

      if (debug) {
        const ok = mapped.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon)).length
        console.log(`[HexMap] mapped ${mapped.length} rows; ${ok} have valid lat/lon`)
        console.log('[mapped0]', mapped[0])
      }

      return mapped
    } finally {
      setViewportLoading(false)
    }
  }




  async function globalExportFilteredCsv() {
    setExporting(true)
    try {
      const rows = rowsFilteredRef.current || []
      const header = 'hex_idx,id,group_id,provider,conn_tag,timestamp,lat,lon,down_mbps,up_mbps,ping_ms,jitter_ms,loss_pct\n'
      const lines = rows.map(r => {
        const s = r.__stats || extractStats(r)
        const idx = (Number.isFinite(r?.lat) && Number.isFinite(r?.lon))
          ? h3.latLngToCell(Number(r.lat), Number(r.lon), HEX_RES)
          : ''
        const vals = [
          idx,
          r.id ?? '',
          r.group_id ?? '',
          r.provider ?? '',
          r.__conn ?? r.conn_tag ?? '',
          r.timestamp ?? '',
          r.lat ?? '',
          r.lon ?? '',
          s.down ?? '',
          s.up ?? '',
          s.ping ?? '',
          s.jitter ?? '',
          s.loss ?? ''
        ]
        return vals.map(v => {
          if (v == null) return ''
          const str = String(v)
          return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
        }).join(',')
      })

      const csv = header + lines.join('\n') + (lines.length ? '\n' : '')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const when = new Date().toISOString().replace(/[:.]/g, '-')
      a.href = url
      a.download = `cellwatch_filtered_VIEWPORT_${rows.length}_rows_${when}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

    const map = new mapboxgl.Map({
      container: mapEl.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [-84.396, 33.777],
      zoom: 11,
      interactive: true
    })
    mapRef.current = map

    map.on('load', async () => {
      map.doubleClickZoom.disable()

      map.addSource('points', { type: 'geojson', data: emptyFC(), cluster: true, clusterRadius: 42, clusterMaxZoom: 18 })
      map.addSource('hexes', { type: 'geojson', data: emptyFC() })
      map.addSource('hex-fills', { type: 'geojson', data: emptyFC() })
      map.addSource('hex-centers', { type: 'geojson', data: emptyFC() })

      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'points',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': PALETTE.greyDark,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': PALETTE.white,
          'circle-opacity': 0.9,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 10, 8, 16, 12, 22, 16, 28, 20, 34]
        }
      })
      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'points',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['to-string', ['get', 'point_count']],
          'text-font': ['Inter Regular', 'Arial Unicode MS Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 8, 12, 12, 14, 16, 16, 20, 18],
          'text-allow-overlap': true
        },
        paint: { 'text-color': PALETTE.white }
      })
      map.addLayer({
        id: 'unclustered-count',
        type: 'symbol',
        source: 'points',
        filter: ['!', ['has', 'point_count']],
        layout: {
          'text-field': ['to-string', ['get', 'count']],
          'text-size': 12,
          'text-allow-overlap': true
        },
        paint: { 'text-color': PALETTE.white }
      })


      map.addLayer({ id: 'hex-outline', type: 'line', source: 'hexes', paint: { 'line-color': PALETTE.green, 'line-width': 1, 'line-opacity': 0.55 } })
      map.addLayer({ id: 'hex-fill-active', type: 'fill', source: 'hex-fills', paint: { 'fill-color': PALETTE.greenLight, 'fill-opacity': 0.25 } })
      map.addLayer({
        id: 'hex-count-bubble',
        type: 'circle',
        source: 'hex-centers',
        paint: {
          'circle-color': PALETTE.greenDark,
          'circle-radius': 14,
          'circle-opacity': 0.85,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': PALETTE.white
        }
      })
      map.addLayer({
        id: 'hex-count-label',
        type: 'symbol',
        source: 'hex-centers',
        layout: { 'text-field': ['to-string', ['get', 'count']], 'text-size': 12, 'text-allow-overlap': true },
        paint: { 'text-color': PALETTE.white }
      })

      map.addSource('hex-selected', { type: 'geojson', data: emptyFC() })
      map.addSource('hex-center-selected', { type: 'geojson', data: emptyFC() })

      map.addLayer({ id: 'hex-selected-fill', type: 'fill', source: 'hex-selected', paint: { 'fill-color': TYPE_COLORS.default.fill, 'fill-opacity': 0.20 } })
      map.addLayer({ id: 'hex-selected-outline', type: 'line', source: 'hex-selected', paint: { 'line-color': TYPE_COLORS.default.outline, 'line-width': 3, 'line-opacity': 0.95 } })
      map.addLayer({
        id: 'hex-selected-bubble',
        type: 'circle',
        source: 'hex-center-selected',
        paint: {
          'circle-color': PALETTE.greenDark,
          'circle-radius': 18,
          'circle-opacity': 0.95,
          'circle-stroke-width': 3,
          'circle-stroke-color': PALETTE.white
        }
      })
      map.addLayer({
        id: 'hex-selected-label',
        type: 'symbol',
        source: 'hex-center-selected',
        layout: { 'text-field': ['to-string', ['get', 'count']], 'text-size': 13, 'text-allow-overlap': true },
        paint: { 'text-color': PALETTE.white, 'text-halo-color': PALETTE.greenDark, 'text-halo-width': 1.5 }
      })

      map.once('idle', async () => {
        const initialRows = await fetchViewportRows(map)
        setRowsAll(initialRows)
        safeSetGeoJSON(map, 'points', rowsToPointFeatures(initialRows))
        redrawHexes(map, initialRows, modeRef.current)
        applyModeVisibility(map, modeRef.current)
        updateSelectionOverlay(map, selectedIdxRef.current)
        setMapReady(true)
      })

      const stop = (e) => { e.preventDefault?.(); e.originalEvent?.preventDefault?.(); e.originalEvent?.stopPropagation?.() }

      map.on('click', 'clusters', (e) => {
        stop(e)
        const f = e.features?.[0]
        const clusterId = f?.properties?.cluster_id
        if (!clusterId) return
        map.getSource('points')?.getClusterLeaves(clusterId, 10000, 0, (err, features) => {
          if (err) return
          const ids = new Set((features || []).map(x => x?.properties?.id).filter(Boolean))
          const items = (rowsFilteredRef.current || []).filter(r => ids.has(r.id))
          const idx = e.lngLat ? h3.latLngToCell(e.lngLat.lat, e.lngLat.lng, HEX_RES) : null
          if (!idx) return
          const payload = buildSheetData(idx, items, typeFilters)
          setPanelData(payload)
          setPanelOpen(true)
          setSelectedIdx(idx)
          updateSelectionOverlay(mapRef.current, idx)
        })
      })

      map.on('click', 'cluster-count', (e) => {
        stop(e)
        const f = e.features?.[0]
        const clusterId = f?.properties?.cluster_id
        if (!clusterId) return
        map.getSource('points')?.getClusterLeaves(clusterId, 10000, 0, (err, features) => {
          if (err) return
          const ids = new Set((features || []).map(x => x?.properties?.id).filter(Boolean))
          const items = (rowsFilteredRef.current || []).filter(r => ids.has(r.id))
          const idx = e.lngLat ? h3.latLngToCell(e.lngLat.lat, e.lngLat.lng, HEX_RES) : null
          if (!idx) return
          const payload = buildSheetData(idx, items, typeFilters)
          setPanelData(payload)
          setPanelOpen(true)
          setSelectedIdx(idx)
          updateSelectionOverlay(mapRef.current, idx)
        })
      })

      map.on('click', 'unclustered-point', (e) => {
        stop(e)
        const f = e.features?.[0]
        if (!f?.geometry?.coordinates) return
        const [lng, lat] = f.geometry.coordinates
        const clickedId = f.properties?.id || null
        openDotSheet(lng, lat, clickedId)
        const row = clickedId ? (rowsFilteredRef.current || []).find(r => r.id === clickedId) : null
        onPointClick?.(row || clickedId)
      })

      const onHexClick = (e) => {
        stop(e)
        const f = e.features?.[0]
        const idx = f?.properties?.idx
        if (idx) openHexSheet(idx)
      }
      map.on('click', 'hex-fill-active', onHexClick)
      map.on('click', 'hex-count-bubble', onHexClick)
      map.on('click', 'hex-count-label', onHexClick)

      map.on('dblclick', (e) => { e.preventDefault?.(); e.originalEvent?.preventDefault?.() })

      let raf = 0
      const refresh = () => {
        if (raf) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(async () => {
          if (!map || !map.style) { raf = 0; return }
          const latest = await fetchViewportRows(map)
          setRowsAll(latest)
          raf = 0
        })
      }

      map.on('moveend', refresh)
      map.on('zoomend', refresh)

      map.on('zoomend', () => {
        applyModeVisibility(map, modeRef.current)
        redrawHexes(map, rowsAllRef.current, modeRef.current)
      })
    })

    map.on('error', () => {})

    return () => {
      try { map.remove() } catch {}
      mapRef.current = null
      setMapReady(false)
      cellItemsRef.current = new Map()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    safeSetGeoJSON(map, 'points', rowsToPointFeatures(rowsFiltered))
    redrawHexes(map, rowsFiltered, modeRef.current)
    applyModeVisibility(map, modeRef.current)
    updateSelectionOverlay(map, selectedIdxRef.current)
  }, [rowsFiltered, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    applyModeVisibility(map, mode)
    redrawHexes(map, rowsFiltered, mode)
    updateSelectionOverlay(map, selectedIdxRef.current)
  }, [mapReady, mode, rowsFiltered])

  useEffect(() => {
    if (!mapRef.current) return

    const searchApi = {
      getMapCenter: () => {
        const map = mapRef.current
        if (!map) return null
        const c = map.getCenter()
        return { lng: c.lng, lat: c.lat }
      },
      onPick: (lngLat) => {
        const map = mapRef.current
        if (!map || !lngLat) return
        map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: Math.max(map.getZoom(), 13) })
      },
      onPickHex: (hexIdx) => {
        if (!hexIdx) return
        openHexSheet(hexIdx)
      }
    }

    const exportFn = async () => globalExportFilteredCsv()

    if (onRegisterSearch) onRegisterSearch(searchApi)
    if (onRegisterExport) onRegisterExport(exportFn)
  }, [])

  return (
    <>
      {exporting && (
        <div style={{
          position: 'fixed', right: 16, bottom: 16, background: PALETTE.greenDark,
          color: '#fff', padding: '10px 12px', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.2)', zIndex: 10003
        }}>
          Exporting filtered data…
        </div>
      )}

      {viewportLoading && (
        <div
          style={{
            position: 'fixed',
            top: '4.5rem',
            left: '50%',
            transform: 'translateX(-50%)',
            background: PALETTE.greenDark,
            color: '#fff',
            padding: '8px 14px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 500,
            zIndex: 10030,
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            pointerEvents: 'none'
          }}
        >
          Loading data…
        </div>
      )}

      <div
        ref={mapEl}
        style={{
          position: 'absolute',
          inset: 0,
          userSelect: 'none',
          WebkitUserSelect: 'none',
          MozUserSelect: 'none',
          msUserSelect: 'none'
        }}
      />

      <RightPanel
        open={panelOpen}
        data={panelData}
        onClose={() => {
          setPanelOpen(false)
          setSelectedIdx(null)
          updateSelectionOverlay(mapRef.current, null)
        }}
      />
    </>
  )
}
