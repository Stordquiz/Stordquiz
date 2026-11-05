const SUPABASE_URL = 'https://owgldsfxpmzpkipgeksr.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93Z2xkc2Z4cG16cGtpcGdla3NyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDM2NTYsImV4cCI6MjA5MjM3OTY1Nn0.bD5dNHcQfjjq29DprTnVafxuZeCvt30zu0qQItq6AXY'
const { createClient } = supabase
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const quizId = new URLSearchParams(location.search).get('quiz')
let sessionId = null, players = [], totalQs = 0, channel = null
let huntStartTime = null, timerInt = null, quizName = ''
let isPaused = false, pausedAt = null, totalPausedMs = 0
let countMap = {} // lokal svar-tel per spelar — unngår DB-kall på kvart svar

// ── Custom confirm modal (no confirm() — breaks on mobile) ──────────────────
function showConfirmModal(msg, onConfirm) {
  const overlay = document.getElementById('confirm-modal')
  document.getElementById('confirm-msg').textContent = msg
  overlay.classList.add('active')

  function close() { overlay.classList.remove('active') }

  document.getElementById('confirm-ok').onclick = () => { close(); onConfirm() }
  document.getElementById('confirm-cancel').onclick = close
  overlay.onclick = (e) => { if (e.target === overlay) close() }
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  if (!quizId) { toast('Ingen quiz vald'); return }
  const { data: { user } } = await sb.auth.getUser()
  if (!user) { location.href = 'login.html'; return }

  const { data: quiz, error: qe } = await sb.from('quizzes').select('id,name,color,session_count').eq('id', quizId).single()
  if (qe || !quiz) { toast('Fann ikkje quizen'); return }
  quizName = quiz.name

  const { data: qs } = await sb.from('questions').select('id').eq('major_id', quizId)
  totalQs = qs?.length || 0

  // Find existing non-finished session (URL param → DB lookup → create new)
  const urlSessionId = new URLSearchParams(location.search).get('session')
  let existingSess = null

  if (urlSessionId) {
    const { data } = await sb.from('sessions').select('id,join_code,status,started_at,is_paused,paused_at,total_paused_ms').eq('id', urlSessionId).single()
    existingSess = data
  }
  // Check localStorage for a session we created before
  if (!existingSess) {
    const storedId = localStorage.getItem('host_session_' + quizId)
    if (storedId) {
      const { data } = await sb.from('sessions')
        .select('id,join_code,status,started_at,is_paused,paused_at,total_paused_ms').eq('id', storedId).in('status', ['waiting', 'active']).maybeSingle()
      existingSess = data
    }
  }
  if (existingSess) {
    sessionId = existingSess.id
    const { data: ep } = await sb.from('session_players').select('id,nickname,avatar_color,total_score,hunt_finished_at,is_active').eq('session_id', sessionId).eq('is_active', true)
    players = ep || []
    showLobby(quiz, existingSess.join_code)
    setupRealtime()
    if (existingSess.status === 'active') {
      huntStartTime = existingSess.started_at ? new Date(existingSess.started_at).getTime() : Date.now()
      isPaused = existingSess.is_paused || false
      totalPausedMs = existingSess.total_paused_ms || 0
      pausedAt = existingSess.paused_at ? new Date(existingSess.paused_at).getTime() : null
      document.getElementById('lobby').style.display = 'none'
      const huntEl = document.getElementById('hunt'); huntEl.style.display = 'flex'
      document.getElementById('hunt-qname').textContent = quizName
      document.getElementById('hunt-qcount').textContent = `${totalQs} spørsmål`
      updatePauseBtn()
      if (!isPaused) startTimer()
      await refreshLeaderboard()
    }
    return
  }

  // No existing session — create new (retry på PIN-kollisjon med andre opne økter)
  let sess = null, se = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const pin = String(Math.floor(100000 + Math.random() * 900000))
    const res = await sb.from('sessions').insert({
      quiz_id: quizId, join_code: pin, status: 'waiting', host_id: user.id
    }).select().single()
    if (!res.error) { sess = res.data; break }
    se = res.error
    if (res.error.code !== '23505') break // berre retry på unique-kollisjon
  }
  if (!sess) { toast('Kunne ikkje opprette økt: ' + (se?.message || 'ukjend feil')); console.error(se); return }
  sessionId = sess.id
  localStorage.setItem('host_session_' + quizId, sess.id)
  await sb.from('quizzes').update({ session_count: (quiz.session_count || 0) + 1 }).eq('id', quizId)
  showLobby(quiz, sess.join_code)
  setupRealtime()
}

function showLobby(quiz, pin) {
  document.getElementById('lobby-loading').style.display = 'none'
  const lc = document.getElementById('lobby-content'); lc.classList.remove('hidden'); lc.style.display = 'flex'
  document.getElementById('qname').textContent = quiz.name
  document.getElementById('qsub').textContent = `${totalQs} spørsmål`
  document.getElementById('pin-num').textContent = pin
  const base = 'https://stordquiz.no/'
  document.getElementById('pin-url').textContent = base
  document.getElementById('join-strong').textContent = base
  renderLobbyPlayers()
}

function setupRealtime() {
  channel = sb.channel('session:' + sessionId)
  channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'session_players', filter: `session_id=eq.${sessionId}` }, (p) => {
    // Unngå duplikat viss vi allereie har spelaren frå ein tidlegare fetch
    if (!players.find(x => x.id === p.new.id)) {
      players.push(p.new)
      renderLobbyPlayers()
    }
  })
  channel.on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'session_players', filter: `session_id=eq.${sessionId}` }, async () => {
    // Spelar sletta — treng full re-fetch for å fjerne frå lista
    await refreshLeaderboard()
    renderLobbyPlayers()
  })
  channel.on('broadcast', { event: 'player_left' }, async () => {
    // Spelar forlet — treng full re-fetch
    await refreshLeaderboard()
    renderLobbyPlayers()
  })
  channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'session_answers', filter: `session_id=eq.${sessionId}` }, (p) => {
    // Nytt svar — oppdater lokal teljing, ingen DB-kall
    const pid = p.new.player_id
    countMap[pid] = (countMap[pid] || 0) + 1
    renderLeaderboard()
  })
  channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'session_players', filter: `session_id=eq.${sessionId}` }, (p) => {
    // Score-oppdatering — oppdater lokal array, ingen DB-kall
    const idx = players.findIndex(x => x.id === p.new.id)
    if (idx >= 0) players[idx] = p.new; else players.push(p.new)
    renderLeaderboard()
  })
  channel.subscribe(async (status, err) => {
    const el = document.getElementById('rtstat')
    if (status === 'SUBSCRIBED') {
      el.textContent = '🟢 Realtime tilkobla'; el.style.color = 'var(--accent)'
      // Full re-fetch ved (re)tilkobling — initialiserer lokal state
      const { data: fresh } = await sb.from('session_players').select('id,nickname,avatar_color,total_score,hunt_finished_at,is_active').eq('session_id', sessionId).eq('is_active', true)
      if (fresh) { players = fresh; renderLobbyPlayers() }
    } else if (status === 'CHANNEL_ERROR') {
      el.textContent = '🔴 Realtime feil — prøv å laste sida på nytt'; el.style.color = 'var(--red)'; console.error(err)
    }
  })
}

// ── XSS-vern: elevar vel kallenamn/farge sjølv, så alt må escapast før innsetting
// i lærarens (autentiserte) side. Fargen valideras til gyldig hex.
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}
function safeColor(c) {
  return /^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(c || '') ? c : '#4d9fff'
}

function renderLobbyPlayers() {
  const w = document.getElementById('pwrap')
  w.innerHTML = players.length === 0
    ? '<p style="color:var(--muted);font-size:.85rem;">Ventar på elevar…</p>'
    : players.map(p => `<div class="pchip"><div class="pdot" style="background:${safeColor(p.avatar_color)}"></div>${esc(p.nickname)}</div>`).join('')
  document.getElementById('pcnt').textContent = `${players.length} elev${players.length !== 1 ? 'ar' : ''} tilkobla`
}

window.startHunt = async function () {
  if (players.length === 0) return toast('Ingen elevar enno!')
  if (totalQs === 0) return toast('Quizen har ingen spørsmål!')

  huntStartTime = Date.now()
  isPaused = false; pausedAt = null; totalPausedMs = 0
  const { error: startErr } = await sb.from('sessions')
    .update({ status: 'active', started_at: new Date().toISOString(), is_paused: false, total_paused_ms: 0 })
    .eq('id', sessionId)
  if (startErr) {
    console.error('Could not start session:', startErr)
    toast('Feil ved start: ' + startErr.message)
    return
  }
  await channel.send({ type: 'broadcast', event: 'game_start', payload: { session_id: sessionId } })

  document.getElementById('lobby').style.display = 'none'
  const huntEl = document.getElementById('hunt'); huntEl.style.display = 'flex'
  document.getElementById('hunt-qname').textContent = quizName
  document.getElementById('hunt-qcount').textContent = `${totalQs} spørsmål`

  updatePauseBtn()
  startTimer()
  await refreshLeaderboard()
}

function startTimer() {
  clearInterval(timerInt)
  timerInt = setInterval(() => {
    const elapsed = Math.floor((Date.now() - huntStartTime - totalPausedMs) / 1000)
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0')
    const s = String(elapsed % 60).padStart(2, '0')
    const el = document.getElementById('hunt-timer')
    if (el) el.textContent = `${m}:${s}`
  }, 1000)
}

function updatePauseBtn() {
  const btn = document.getElementById('btn-pause')
  if (!btn) return
  if (isPaused) {
    btn.textContent = '▶ Fortsett'
    btn.style.background = 'var(--green)'
    btn.style.color = '#0f0f13'
    document.getElementById('hunt-timer').style.opacity = '0.5'
  } else {
    btn.textContent = '⏸ Pause'
    btn.style.background = ''
    btn.style.color = ''
    document.getElementById('hunt-timer').style.opacity = '1'
  }
}

window.togglePause = async function () {
  if (!isPaused) {
    // PAUSE
    clearInterval(timerInt)
    isPaused = true
    pausedAt = Date.now()
    updatePauseBtn()
    await sb.from('sessions').update({ is_paused: true, paused_at: new Date(pausedAt).toISOString() }).eq('id', sessionId)
    await channel.send({ type: 'broadcast', event: 'timer_pause', payload: {} })
    toast('⏸ Tidtakar pause')
  } else {
    // RESUME
    const pausedDuration = Date.now() - pausedAt
    totalPausedMs += pausedDuration
    isPaused = false
    pausedAt = null
    updatePauseBtn()
    await sb.from('sessions').update({ is_paused: false, paused_at: null, total_paused_ms: totalPausedMs }).eq('id', sessionId)
    await channel.send({ type: 'broadcast', event: 'timer_resume', payload: { total_paused_ms: totalPausedMs } })
    startTimer()
    toast('▶ Tidtakar starta')
  }
}

// Full DB-fetch — bruk berre ved oppstart, reconnect og spelar-leave
async function refreshLeaderboard() {
  const [{ data: playerData }, { data: answerCounts }] = await Promise.all([
    sb.from('session_players')
      .select('id, nickname, avatar_color, total_score, hunt_finished_at')
      .eq('session_id', sessionId)
      .eq('is_active', true),
    sb.from('session_answers')
      .select('player_id')
      .eq('session_id', sessionId)
  ])
  // Initialiser lokal countMap frå DB-data
  countMap = {}
  ;(answerCounts || []).forEach(a => { countMap[a.player_id] = (countMap[a.player_id] || 0) + 1 })
  players = playerData || []
  renderLeaderboard()
}

// Berre re-render — ingen DB-kall
function renderLeaderboard() {
  const sorted = [...players].sort((a, b) => {
    if (b.total_score !== a.total_score) return b.total_score - a.total_score
    if (a.hunt_finished_at && b.hunt_finished_at) return new Date(a.hunt_finished_at) - new Date(b.hunt_finished_at)
    if (a.hunt_finished_at) return -1
    if (b.hunt_finished_at) return 1
    return (countMap[b.id] || 0) - (countMap[a.id] || 0)
  })
  const MEDALS = ['🥇', '🥈', '🥉']
  const RANK_CLS = ['gold', 'silver', 'bronze']
  document.getElementById('lb-list').innerHTML = sorted.length === 0
    ? '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:.5rem;">Ventar på svar…</p>'
    : sorted.map((p, i) => {
      const answered = countMap[p.id] || 0
      const done = p.hunt_finished_at
      const timeStr = done && huntStartTime ? formatTime(new Date(p.hunt_finished_at) - huntStartTime) : ''
      return `
      <div class="lb-row ${RANK_CLS[i] || ''}">
        <span class="lb-rank">${MEDALS[i] || i + 1}</span>
        <div class="lb-dot" style="background:${safeColor(p.avatar_color)}"></div>
        <span class="lb-name">${esc(p.nickname)}</span>
        <span class="lb-progress">${answered}/${totalQs}</span>
        ${done ? `<span class="lb-done-badge">✓ Ferdig</span>` : ''}
        ${timeStr ? `<span class="lb-time">${timeStr}</span>` : ''}
        <span class="lb-score">${p.total_score}</span>
      </div>`
    }).join('')
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

window.endHunt = async function () {
  showConfirmModal('Avslutte jakta? Poeng vert lagra og elevar får sjå sluttresultata.', async () => {
    clearInterval(timerInt)
    await sb.from('sessions').update({ status: 'finished', ended_at: new Date().toISOString() }).eq('id', sessionId)
    localStorage.removeItem('host_session_' + quizId)
    await channel.send({ type: 'broadcast', event: 'game_over', payload: {} })
    await showFinal()
  })
}

async function showFinal() {
  // Always fetch fresh scores from DB — local players array may be stale
  const [{ data: freshPlayers }, { data: answerCounts }] = await Promise.all([
    sb.from('session_players')
      .select('id, nickname, avatar_color, total_score, hunt_finished_at')
      .eq('session_id', sessionId),
    sb.from('session_answers').select('player_id').eq('session_id', sessionId)
  ])

  const finalCountMap = {}
  ;(answerCounts || []).forEach(a => { finalCountMap[a.player_id] = (finalCountMap[a.player_id] || 0) + 1 })

  const sorted = (freshPlayers || []).sort((a, b) => {
    if (b.total_score !== a.total_score) return b.total_score - a.total_score
    if (a.hunt_finished_at && b.hunt_finished_at) return new Date(a.hunt_finished_at) - new Date(b.hunt_finished_at)
    if (a.hunt_finished_at) return -1
    if (b.hunt_finished_at) return 1
    return 0
  })

  document.getElementById('hunt').style.display = 'none'
  const finalEl = document.getElementById('final'); finalEl.style.display = 'flex'
  document.getElementById('final-sub').textContent = `${sorted.length} elevar • ${totalQs} spørsmål`

  const MEDALS = ['🥇', '🥈', '🥉']
  document.getElementById('final-lb').innerHTML = sorted.map((p, i) => {
    const answered = finalCountMap[p.id] || 0
    const timeStr = p.hunt_finished_at && huntStartTime ? formatTime(new Date(p.hunt_finished_at) - huntStartTime) : '–'
    return `
  <div class="final-row" style="animation-delay:${i * .08}s">
    <span class="lb-rank">${MEDALS[i] || i + 1}</span>
    <div class="lb-dot" style="background:${safeColor(p.avatar_color)}"></div>
    <span class="lb-name">${esc(p.nickname)}</span>
    <span class="lb-progress" style="font-size:.8rem;color:var(--muted)">${answered}/${totalQs} svar</span>
    <span class="lb-time" style="font-size:.8rem;color:var(--muted)">${timeStr}</span>
    <span class="lb-score">${p.total_score}</span>
  </div>`
  }).join('')
}

function toast(msg) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 3000)
}

window.cancelSession = async function () {
  showConfirmModal('Vil du avslutte denne økta? Elevar som er med vil bli kasta ut.', async () => {
    if (sessionId) {
      await sb.from('sessions').update({ status: 'finished', ended_at: new Date().toISOString() }).eq('id', sessionId)
      localStorage.removeItem('host_session_' + quizId)
      await channel?.send({ type: 'broadcast', event: 'game_over', payload: {} })
    }
    location.href = 'dashboard.html'
  })
}

init()
