import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const SUPABASE_URL = 'https://owgldsfxpmzpkipgeksr.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93Z2xkc2Z4cG16cGtpcGdla3NyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDM2NTYsImV4cCI6MjA5MjM3OTY1Nn0.bD5dNHcQfjjq29DprTnVafxuZeCvt30zu0qQItq6AXY'
const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const COLORS = ['#ff4d6d', '#4d9fff', '#50f0a0', '#f0c050', '#c8f050', '#7c6cff', '#ff9f50', '#f050c8', '#50c8f0', '#a0f050']
let chosenColor = COLORS[0]
let sessionId = null, quizId = null, playerId = null, totalQs = 0
let huntStartTime = null, timerInt = null, channel = null
let answeredQuestions = []
let totalPausedMs = 0, isPaused = false

// Restore hunt timer from localStorage if page was refreshed mid-hunt
const savedHuntStart = localStorage.getItem('quiz_hunt_start')
if (savedHuntStart) huntStartTime = parseInt(savedHuntStart)

const savedIdentity = JSON.parse(localStorage.getItem('quiz_identity') || 'null')
if (savedIdentity?.playerId) {
  restoreSession(savedIdentity)
} else {
  buildColorPicker()
  show('pin-screen')
}

function buildColorPicker() {
  const row = document.getElementById('crow')
  row.innerHTML = ''
  COLORS.forEach((c, i) => {
    const d = document.createElement('div')
    d.className = 'cdot' + (i === 0 ? ' on' : '')
    d.style.background = c
    d.onclick = () => {
      document.querySelectorAll('.cdot').forEach(x => x.classList.remove('on'))
      d.classList.add('on')
      chosenColor = c
    }
    row.appendChild(d)
  })
}

async function restoreSession(identity) {
  sessionId = identity.sessionId; quizId = identity.quizId; playerId = identity.playerId
  if (identity.totalQs) totalQs = identity.totalQs
  const { data: sess } = await sb.from('sessions').select('status,quizzes(name,question_count)').eq('id', sessionId).single()
  if (!sess) { localStorage.removeItem('quiz_identity'); buildColorPicker(); show('pin-screen'); return }
  totalQs = sess.quizzes?.question_count || identity.totalQs || 0
  const { data: actualQs } = await sb.from('questions').select('id').eq('major_id', identity.quizId)
  if (actualQs?.length) totalQs = actualQs.length
  if (sess.status === 'waiting') {
    document.getElementById('wait-name').textContent = sess.quizzes?.name || 'Quiz'
    document.getElementById('wait-nick').textContent = identity.nickname || ''
    show('wait-screen'); subscribeToSession()
  } else if (sess.status === 'active') {
    document.body.classList.add('hunt-active')
    await startHunt(true)
  } else {
    localStorage.removeItem('quiz_identity')
    localStorage.removeItem('quiz_hunt_start')
    buildColorPicker()
    show('pin-screen')
    toast('Quizen du var med i er avslutta')
  }
}

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'))
  document.getElementById(id).classList.remove('hidden')
  // Lærar-innloggingslenka skal berre visast på PIN-skjermen (unngå glimt under jakt/boot)
  const tl = document.querySelector('.tlink')
  if (tl) tl.classList.toggle('hidden', id !== 'pin-screen')
}
window.show = show

// ── CHECK PIN ──
window.checkPin = async function () {
  localStorage.removeItem('quiz_hunt_start')
  const pin = document.getElementById('pin-inp').value.trim()
  if (pin.length !== 6) return toast('PIN må vere 6 siffer')
  const { data: s } = await sb.from('sessions').select('id,quiz_id,status,quizzes(name,question_count)').eq('join_code', pin).in('status', ['waiting', 'active']).single()
  if (!s) return toast('Fann ingen aktiv quiz med den PIN-koden')
  sessionId = s.id; quizId = s.quiz_id
  totalQs = s.quizzes?.question_count || 0
  const { data: realQs } = await sb.from('questions').select('id').eq('major_id', s.quiz_id)
  if (realQs?.length) totalQs = realQs.length
  document.getElementById('wait-name').textContent = s.quizzes?.name || 'Quiz'
  show('nick-screen')
  buildColorPicker()
}

// ── JOIN ──
window.joinGame = async function () {
  const nick = document.getElementById('nick-inp').value.trim()
  if (!nick) return toast('Skriv inn eit kallenamn')
  if (nick.length > 30) return toast('Kallenamnet er for langt (maks 30 teikn)')
  if (/[<>"'`]/.test(nick)) return toast('Kallenamnet inneheld ugyldige teikn')
  // Berre farge frå den godkjende lista — hindrar CSS/style-injeksjon
  const color = COLORS.includes(chosenColor) ? chosenColor : COLORS[0]
  const { data: p, error } = await sb.from('session_players').insert({ session_id: sessionId, nickname: nick, avatar_color: color }).select('id').single()
  if (error) return toast('Kunne ikkje bli med: ' + error.message)
  playerId = p.id
  localStorage.setItem('quiz_identity', JSON.stringify({ sessionId, quizId, playerId, nickname: nick, totalQs }))
  document.getElementById('wait-nick').textContent = nick
  const { data: sess } = await sb.from('sessions').select('status').eq('id', sessionId).single()
  if (sess?.status === 'active') {
    document.body.classList.add('hunt-active')
    await startHunt(false)
  } else {
    show('wait-screen')
    subscribeToSession()
  }
}

// ── REALTIME: listen for game_start from teacher ──
function subscribeToSession() {
  channel = sb.channel('session:' + sessionId)
  channel.on('broadcast', { event: 'game_start' }, async () => {
    await startHunt(false)
  })
  channel.on('broadcast', { event: 'game_over' }, () => {
    kickToPin()
  })
  channel.on('broadcast', { event: 'timer_pause' }, () => {
    clearInterval(timerInt)
    isPaused = true
    const el = document.getElementById('hunt-timer')
    if (el) { el.textContent = el.textContent.replace(' ⏸', '') + ' ⏸'; el.style.opacity = '0.5' }
    setScanLocked(true)
  })
  channel.on('broadcast', { event: 'timer_resume' }, (e) => {
    totalPausedMs = e.payload?.total_paused_ms ?? totalPausedMs
    isPaused = false
    const el = document.getElementById('hunt-timer')
    if (el) { el.style.opacity = '1' }
    startHuntTimer()
    setScanLocked(false)
  })
  // (session_answers er ikkje lenger direkte lesbar for anon — svar hentast via RPC)
  channel.subscribe()
}

// Refresh answers når eleven kjem tilbake til fana (t.d. etter å ha svara på question.html)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && playerId) {
    refreshAnswers()
  }
})

// ── START HUNT ──
async function startHunt(alreadyStarted) {
  if (!alreadyStarted) {
    huntStartTime = Date.now()
    totalPausedMs = 0; isPaused = false
    localStorage.setItem('quiz_hunt_start', String(huntStartTime))
    await sb.from('session_players').update({ hunt_started_at: new Date().toISOString() }).eq('id', playerId)
  } else {
    const saved = localStorage.getItem('quiz_hunt_start')
    if (saved) {
      huntStartTime = parseInt(saved)
    } else {
      const { data: pl } = await sb.from('session_players').select('hunt_started_at').eq('id', playerId).single()
      huntStartTime = pl?.hunt_started_at ? new Date(pl.hunt_started_at).getTime() : Date.now()
      localStorage.setItem('quiz_hunt_start', String(huntStartTime))
    }
    const { data: sess } = await sb.from('sessions').select('is_paused, paused_at, total_paused_ms').eq('id', sessionId).single()
    isPaused = sess?.is_paused || false
    totalPausedMs = sess?.total_paused_ms || 0
    if (isPaused && sess?.paused_at) {
      const frozenElapsed = Math.floor((new Date(sess.paused_at).getTime() - huntStartTime - totalPausedMs) / 1000)
      const m = String(Math.floor(frozenElapsed / 60)).padStart(2, '0')
      const s = String(frozenElapsed % 60).padStart(2, '0')
      document.body.classList.add('hunt-active')
      show('hunt-screen')
      const el = document.getElementById('hunt-timer')
      if (el) { el.textContent = `${m}:${s} ⏸`; el.style.opacity = '0.5' }
      setScanLocked(true)
      await refreshAnswers()
      if (!channel) subscribeToSession()
      return
    }
  }
  document.body.classList.add('hunt-active')
  show('hunt-screen')
  startHuntTimer()
  setScanLocked(false)
  await refreshAnswers()
  if (!channel) subscribeToSession()
}

// ── LÅS SKANN-KNAPPEN under pause ──
function setScanLocked(locked) {
  const btn = document.querySelector('.btn-scan')
  if (!btn) return
  if (locked) {
    btn.dataset.href = btn.getAttribute('href') || btn.dataset.href
    btn.removeAttribute('href')
    btn.style.opacity = '0.4'
    btn.style.pointerEvents = 'none'
    btn.textContent = '⏸ Pausa av læraren'
  } else {
    if (btn.dataset.href) btn.setAttribute('href', btn.dataset.href)
    btn.style.opacity = '1'
    btn.style.pointerEvents = ''
    btn.textContent = '📷 Skann QR-kode'
  }
}

// ── TIMER ──
function startHuntTimer() {
  clearInterval(timerInt)
  const el = document.getElementById('hunt-timer')
  if (el) el.style.opacity = '1'
  timerInt = setInterval(() => {
    const elapsed = Math.floor((Date.now() - huntStartTime - totalPausedMs) / 1000)
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0')
    const s = String(elapsed % 60).padStart(2, '0')
    const el = document.getElementById('hunt-timer')
    if (el) el.textContent = `${m}:${s}`
  }, 1000)
}

// ── REFRESH ANSWERS ──
async function refreshAnswers() {
  const { data: answers } = await sb
    .from('session_answers')
    .select('question_id, selected_option, is_correct, points_earned, questions(question_text)')
    .eq('player_id', playerId)
    .eq('session_id', sessionId)

  const { data: player } = await sb.from('session_players').select('total_score').eq('id', playerId).single()

  answeredQuestions = answers || []
  const score = player?.total_score || 0
  const answered = answeredQuestions.length

  const scoreEl = document.getElementById('hunt-score')
  if (scoreEl) scoreEl.textContent = score

  const pct = totalQs > 0 ? Math.round(answered / totalQs * 100) : 0
  const pbar = document.getElementById('progress-bar')
  const ptxt = document.getElementById('progress-text')
  if (pbar) pbar.style.width = pct + '%'
  if (ptxt) ptxt.textContent = `${answered} av ${totalQs} spørsmål`

  const list = document.getElementById('answered-list')
  if (list) {
    if (answeredQuestions.length === 0) {
      list.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:.5rem;">Ingen svar enno — finn ein QR-kode!</p>'
    } else {
      list.innerHTML = answeredQuestions.map(a => `
        <div class="ans-row ${a.is_correct ? 'correct' : 'wrong'}">
          <span class="ans-icon">${a.is_correct ? '✅' : '❌'}</span>
          <span class="ans-text">${esc(a.questions?.question_text || 'Spørsmål')}</span>
          <span class="ans-pts">${a.is_correct ? '+' + a.points_earned : '0'}</span>
        </div>`).join('')
    }
  }

  if (totalQs > 0 && answered >= totalQs) {
    endHunt()
  }
}

// ── END HUNT ──
async function endHunt() {
  clearInterval(timerInt)
  if (channel) channel.unsubscribe()
  const { data: player } = await sb.from('session_players').select('total_score, hunt_finished_at').eq('id', playerId).single()
  if (player && !player.hunt_finished_at) {
    await sb.from('session_players').update({ hunt_finished_at: new Date().toISOString() }).eq('id', playerId)
  }
  const elapsed = huntStartTime ? Math.floor((Date.now() - huntStartTime - totalPausedMs) / 1000) : 0
  const m = Math.floor(elapsed / 60), s = elapsed % 60
  localStorage.removeItem('quiz_identity')
  localStorage.removeItem('quiz_hunt_start')
  document.body.classList.remove('hunt-active')
  show('done-screen')
  document.getElementById('done-score').textContent = player?.total_score || 0
  document.getElementById('done-time').textContent = `Tid brukt: ${m}m ${s}s`
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toast(msg) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 3000)
}

// ── NEW QUIZ (from done screen) ──
window.newQuiz = function () {
  sessionId = null; quizId = null; playerId = null; huntStartTime = null
  document.body.classList.remove('hunt-active')
  show('pin-screen')
}

// ── KICKED BY TEACHER ──
function kickToPin() {
  clearInterval(timerInt)
  if (channel) channel.unsubscribe()
  localStorage.removeItem('quiz_identity')
  localStorage.removeItem('quiz_hunt_start')
  sessionId = null; quizId = null; playerId = null; huntStartTime = null
  document.body.classList.remove('hunt-active')
  const t = document.createElement('div')
  t.className = 'toast'
  t.textContent = '⏹️ Læraren avslutta quizen'
  document.body.appendChild(t)
  setTimeout(() => {
    t.remove()
    buildColorPicker()
    show('pin-screen')
  }, 2500)
}

// ── GO BACK TO PIN (from nickname screen) ──
window.goBackToPin = async function () {
  if (playerId) {
    await sb.from('session_players').delete().eq('id', playerId)
    if (channel) channel.send({ type: 'broadcast', event: 'player_left', payload: {} })
    playerId = null
    localStorage.removeItem('quiz_identity')
  }
  show('pin-screen')
}

// ── LEAVE QUIZ (custom modal — no confirm() on mobile) ──
window.leaveQuiz = function () {
  document.getElementById('leave-modal').classList.add('active')
}

window.closeLeaveModal = function () {
  document.getElementById('leave-modal').classList.remove('active')
}

window.confirmLeave = async function () {
  document.getElementById('leave-modal').classList.remove('active')
  const pid = playerId
  const sid = sessionId
  clearInterval(timerInt)
  localStorage.removeItem('quiz_identity')
  localStorage.removeItem('quiz_hunt_start')
  sessionId = null; quizId = null; playerId = null; huntStartTime = null
  document.body.classList.remove('hunt-active')
  show('pin-screen')
  if (pid) {
    await sb.from('session_players').update({ is_active: false }).eq('id', pid)
  }
  if (channel) { channel.unsubscribe(); channel = null }
}

// Close modal when clicking outside the box
document.getElementById('leave-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('leave-modal')) {
    document.getElementById('leave-modal').classList.remove('active')
  }
})
