// question.js — scavenger hunt QR landing page
const SUPABASE_URL = 'https://owgldsfxpmzpkipgeksr.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93Z2xkc2Z4cG16cGtpcGdla3NyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDM2NTYsImV4cCI6MjA5MjM3OTY1Nn0.bD5dNHcQfjjq29DprTnVafxuZeCvt30zu0qQItq6AXY'
const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_KEY)

const LETTERS   = ['A','B','C','D']
const identity  = JSON.parse(localStorage.getItem('quiz_identity') || 'null')
const questionId = new URLSearchParams(location.search).get('id')

async function init() {
  if (!questionId)                               return showError('Ingen spørsmål-ID. Skann QR-koden på nytt.')
  if (!identity?.playerId || !identity?.sessionId || !identity?.token) return showNoSession()

  // Sjekk at sesjonen framleis finst og er aktiv
  const { data: sess } = await db.from('sessions').select('status,is_paused').eq('id', identity.sessionId).maybeSingle()
  if (!sess) {
    localStorage.removeItem('quiz_identity')
    localStorage.removeItem('quiz_hunt_start')
    return showSessionGone()
  }
  if (sess.status === 'finished') {
    localStorage.removeItem('quiz_identity')
    localStorage.removeItem('quiz_hunt_start')
    return showSessionOver()
  }
  if (sess.status === 'waiting') {
    return showError('Jakta har ikkje starta enno. Vent til læraren startar!')
  }
  if (sess.is_paused) {
    return showPaused()
  }

  // NB: 'answer' er IKKJE tilgjengeleg for anon lenger — fasit hentast via RPC etter innsending
  const { data: q, error } = await db.from('questions').select('id,major_id,question_text,options,image_url,time_limit').eq('id', questionId).single()
  if (error || !q) return showError('Fann ikkje spørsmålet. Er QR-koden riktig?')

  const [myAnswersRes, playerRes, allQsRes] = await Promise.all([
    db.rpc('get_my_answers', { p_player_id: identity.playerId, p_token: identity.token }),
    db.from('session_players').select('total_score').eq('id', identity.playerId).single(),
    db.from('questions').select('id').eq('major_id', identity.quizId)
  ])

  updateHeader(playerRes.data?.total_score || 0, allQsRes.data?.length || 0)

  const existing = (myAnswersRes.data || []).find(a => a.question_id === questionId) || null

  // Allereie svara → hent fasit (RPC gir berre fasit ETTER innsendt svar)
  let correctAnswers = null
  if (existing) correctAnswers = await fetchCorrectAnswers(q.id)
  renderQuestion(q, existing, correctAnswers)
}

// Hentar fasit via SECURITY DEFINER-RPC — fungerer berre om spelaren har svara
async function fetchCorrectAnswers(qid) {
  const { data } = await db.rpc('get_question_answer', { p_question_id: qid, p_player_id: identity.playerId, p_token: identity.token })
  if (!data) return []
  try { const p = JSON.parse(data); return Array.isArray(p) ? p : [data] }
  catch { return [data] }
}

function updateHeader(score, total) {
  const s = document.getElementById('totalPoints'); if (s) s.textContent = score
  const t = document.getElementById('totalQs');     if (t && total) t.textContent = total
  const pill = document.getElementById('pointsPill')
  if (pill) { pill.classList.remove('bump'); void pill.offsetWidth; pill.classList.add('bump') }
}

function renderQuestion(q, existing, correctAnswers) {
  const options = Array.isArray(q.options) ? q.options : JSON.parse(q.options || '[]')
  const answered = !!existing
  const content  = document.getElementById('content')
  content.innerHTML = ''

  // Question card
  const card = document.createElement('div')
  card.className = 'q-card'
  card.innerHTML = `
    <div class="q-meta">
      <span class="q-badge">Spørsmål</span>
      <span class="q-points-badge">⭐ 1 poeng</span>
    </div>
    ${q.image_url ? `<img class="q-image" src="${esc(q.image_url)}" alt="Bilete">` : ''}
    <div class="q-text">${esc(q.question_text)}</div>`
  content.appendChild(card)

  // Options
  const grid = document.createElement('div')
  grid.className = 'options'
  options.forEach((opt, i) => {
    const btn = document.createElement('button')
    btn.className = 'opt-btn'
    if (answered) {
      const correctOpts = correctAnswers || []
      if (correctOpts.includes(opt))             btn.classList.add('correct')
      else if (opt === existing.selected_option) btn.classList.add('wrong')
      btn.disabled = true
    }
    btn.innerHTML = `<span class="opt-letter">${LETTERS[i]}</span><span>${esc(opt)}</span>`
    // Event listener — never inline onclick — so special chars can't break it
    btn.addEventListener('click', () => submitAnswer(i, options, q))
    grid.appendChild(btn)
  })
  content.appendChild(grid)

  if (answered) {
    content.appendChild(makeBanner(existing.is_correct, existing.points_earned, (correctAnswers || []).join(', ')))
    content.appendChild(makeBackBtn())
  }
}

async function submitAnswer(chosenIdx, options, q) {
  // Lock immediately
  document.querySelectorAll('.opt-btn').forEach(b => b.disabled = true)

  const chosenText = options[chosenIdx]

  // Token-verifisert RPC. DB-triggeren (fn_verify_session_answer) set is_correct +
  // points_earned server-side og blokkerer pausa/avslutta/forlatne sesjonar.
  const { data: savedRows, error } = await db.rpc('submit_answer', {
    p_player_id:       identity.playerId,
    p_token:           identity.token,
    p_question_id:     q.id,
    p_selected_option: chosenText
  })
  const saved = Array.isArray(savedRows) ? savedRows[0] : savedRows

  if (error) {
    const msg = error.message || ''
    if (msg.includes('session_paused'))         return showPaused()
    if (msg.includes('session_not_active'))     return showSessionOver()
    if (msg.includes('player_not_in_session') || msg.includes('invalid_token')) return showNoSession()
    if (msg.includes('question_not_in_quiz'))   return showError('Denne QR-koden høyrer ikkje til quizen du er med i.')
    if (msg.includes('duplicate') || error.code === '23505') {
      return showError('Du har allereie svara på dette spørsmålet.')
    }
    console.error('Kunne ikkje lagre svar:', error)
    return showError('Kunne ikkje lagre svaret. Prøv å skanne QR-koden på nytt.')
  }

  const isCorrect = !!saved?.is_correct
  const pts = saved?.points_earned || 0

  // No som svaret er lagra, kan vi hente fasit via RPC og markere alternativa
  const correctAnswers = await fetchCorrectAnswers(q.id)
  document.querySelectorAll('.opt-btn').forEach((btn, i) => {
    if (correctAnswers.includes(options[i])) btn.classList.add('correct')
    else if (i === chosenIdx)                btn.classList.add('wrong')
  })

  // Les oppdatert score frå DB (score-triggeren har kjørt ferdig)
  const { data: playerAfter } = await db.from('session_players')
    .select('total_score').eq('id', identity.playerId).single()
  updateHeader(playerAfter?.total_score || 0, null)

  const content = document.getElementById('content')
  content.appendChild(makeBanner(isCorrect, pts, correctAnswers.join(', ')))
  content.appendChild(makeBackBtn())
}

function makeBanner(isCorrect, pts, correct) {
  const d = document.createElement('div')
  d.className = `result-banner ${isCorrect ? 'correct-banner' : 'wrong-banner'}`
  d.innerHTML = isCorrect
    ? `<div class="result-icon">🎉</div><div><div class="result-title">Riktig svar!</div><div class="result-desc">+${pts} poeng! Hald fram jakta!</div></div>`
    : `<div class="result-icon">❌</div><div><div class="result-title">Feil svar</div><div class="result-desc">Riktig svar var: <strong style="color:var(--text)">${esc(correct)}</strong></div></div>`
  return d
}

function makeBackBtn() {
  const a = document.createElement('a')
  a.href = 'index.html'
  a.className = 'btn-back'
  a.textContent = '← Tilbake til jakta'
  return a
}

function showNoSession() {
  document.getElementById('content').innerHTML = `
    <div class="center-msg">
      <div style="font-size:2.5rem">🔒</div>
      <div style="font-weight:700;margin-bottom:.5rem;color:var(--text)">Ikkje med i ein quiz</div>
      <div style="font-size:.9rem;color:var(--muted);margin-bottom:1.5rem;">Skriv inn PIN-koden frå læraren fyrst.</div>
      <a href="index.html" class="btn-back">Bli med →</a>
    </div>`
}

function showPaused() {
  document.getElementById('content').innerHTML = `
    <div class="center-msg">
      <div style="font-size:2.5rem">⏸️</div>
      <div style="font-weight:700;margin-bottom:.5rem;color:var(--text)">Quizen er pausa</div>
      <div style="font-size:.9rem;color:var(--muted);margin-bottom:1.5rem;">Læraren har pausa tidtakaren. Vent til quizen startar att, og skann QR-koden på nytt.</div>
      <a href="index.html" class="btn-back">← Tilbake til jakta</a>
    </div>`
}

function showSessionOver() {
  document.getElementById('content').innerHTML = `
    <div class="center-msg">
      <div style="font-size:2.5rem">🏁</div>
      <div style="font-weight:700;margin-bottom:.5rem;color:var(--text)">Quizen er avslutta</div>
      <div style="font-size:.9rem;color:var(--muted);margin-bottom:1.5rem;">Læraren har avslutta denne quizen. Takk for innsatsen!</div>
      <a href="index.html" class="btn-back">Bli med i ny quiz →</a>
    </div>`
}

function showSessionGone() {
  document.getElementById('content').innerHTML = `
    <div class="center-msg">
      <div style="font-size:2.5rem">⌛</div>
      <div style="font-weight:700;margin-bottom:.5rem;color:var(--text)">Quizen finst ikkje lenger</div>
      <div style="font-size:.9rem;color:var(--muted);margin-bottom:1.5rem;">Denne quiz-økta er utgått eller sletta. Spør læraren om ny PIN.</div>
      <a href="index.html" class="btn-back">Til startsida →</a>
    </div>`
}

function showError(msg) {
  document.getElementById('content').innerHTML = `
    <div class="center-msg">
      <div style="font-size:2.5rem">🤔</div>
      <div style="font-size:.9rem;color:var(--muted)">${esc(msg)}</div>
      <a href="index.html" class="btn-back" style="margin-top:1rem;max-width:240px;">← Tilbake</a>
    </div>`
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

init()
