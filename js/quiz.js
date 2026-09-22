const SUPABASE_URL = 'https://owgldsfxpmzpkipgeksr.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93Z2xkc2Z4cG16cGtpcGdla3NyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDM2NTYsImV4cCI6MjA5MjM3OTY1Nn0.bD5dNHcQfjjq29DprTnVafxuZeCvt30zu0qQItq6AXY'
const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_KEY)

const params   = new URLSearchParams(location.search)
const quizId   = params.get('id')
const BASE_URL = 'https://stordquiz.no/question.html'

// Same fargepalett som dashboard – brukt for å finne ink (skriftfarge) til print
const COLORS = [
  { bg: '#c8f050', ink: '#111118' },
  { bg: '#22c55e', ink: '#ffffff' },
  { bg: '#a7f3d0', ink: '#064e3b' },
  { bg: '#3b82f6', ink: '#ffffff' },
  { bg: '#7dd3fc', ink: '#0c4a6e' },
  { bg: '#6366f1', ink: '#ffffff' },
  { bg: '#a855f7', ink: '#ffffff' },
  { bg: '#ec4899', ink: '#ffffff' },
  { bg: '#fdba74', ink: '#7c2d12' },
  { bg: '#f97316', ink: '#ffffff' },
  { bg: '#ef4444', ink: '#ffffff' },
  { bg: '#991b1b', ink: '#ffffff' },
  { bg: '#fde047', ink: '#111118' },
  { bg: '#fef3c7', ink: '#78350f' },
  { bg: '#9ca3af', ink: '#ffffff' },
  { bg: '#1f2937', ink: '#ffffff' }
]
function findColor(bg) {
  return COLORS.find(c => c.bg === bg) || COLORS[0]
}

let currentUser    = null
let currentQuiz    = null
let questions      = []
let localIdCounter = 0

// ── INIT ──
async function init() {
  const { data } = await db.auth.getSession()
  if (!data.session) { window.location.href = 'login.html'; return }
  currentUser = data.session.user
  document.body.classList.add('app-ready')   // auth OK → vis sida

  document.getElementById('userEmail').textContent = currentUser.email.split('@')[0]
  document.getElementById('userInitial').textContent = currentUser.email[0].toUpperCase()

  if (!quizId) {
    document.getElementById('quizTitle').innerHTML = 'Ugyldig <span>quiz</span>'
    return
  }

  const { data: quiz } = await db.from('quizzes').select('id,name,color,category,scheduled_start,scheduled_end').eq('id', quizId).single()
  if (quiz) {
    currentQuiz = quiz
    document.getElementById('quizTitle').innerHTML = `<span>${esc(quiz.name)}</span>`

    // Vis ein liten fargeprikk i tittelen som indikerer quizfargen
    const color = findColor(quiz.color || COLORS[0].bg)
    const titleEl = document.getElementById('quizTitle')
    const dot = document.createElement('span')
    dot.className = 'quiz-color-dot'
    dot.style.background = color.bg
    titleEl.parentNode.insertBefore(dot, titleEl)

    renderScheduleDisplay()
  }

  const { data: qs } = await db
    .from('questions')
    .select('id,major_id,question_text,options,answer,image_url,time_limit,points,order')
    .eq('major_id', quizId)
    .order('order', { ascending: true })

  if (qs && qs.length > 0) {
    questions = qs.map(q => {
      let answers = []
      if (q.answer) {
        try {
          const parsed = JSON.parse(q.answer)
          answers = Array.isArray(parsed) ? parsed : [q.answer]
        } catch {
          answers = [q.answer]
        }
      }
      return {
        ...q,
        options: Array.isArray(q.options) ? q.options : JSON.parse(q.options || '[]'),
        answers,
        _localId: ++localIdCounter,
        _saved: true
      }
    })
    renderList()
  }
}

// ── ADD QUESTION ──
function addQuestion() {
  const q = {
    _localId: ++localIdCounter,
    question_text: '',
    options: ['', '', '', ''],
    answers: [],       // array for multiple correct answers
    answer: '',        // kept for legacy single-answer compat
    points: 1,
    image_url: '',
    _saved: false
  }
  questions.push(q)
  renderList()
  setTimeout(() => {
    const el = document.querySelector(`[data-lid="${q._localId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      toggleItem(el, true)
    }
  }, 50)
}

// ── RENDER LIST ──
function renderList() {
  const list = document.getElementById('qList')

  if (questions.length === 0) {
    list.innerHTML = `
      <div class="empty-qs">
        <div class="empty-icon">📝</div>
        <div class="empty-title">Ingen spørsmål enno</div>
        <div class="empty-desc">Trykk «Nytt spørsmål» for å kome i gang.</div>
      </div>`
    return
  }

  list.innerHTML = ''
  questions.forEach((q, idx) => {
    const item = document.createElement('div')
    item.className = 'q-item'
    item.dataset.lid = q._localId

    const preview = (q.question_text || '').trim() || 'Nytt spørsmål…'
    const previewCls = (q.question_text || '').trim() ? '' : 'empty'

    item.innerHTML = `
      <div class="q-item-header" onclick="toggleItem(this.closest('.q-item'))">
        <div class="q-item-left">
          <div class="q-num">${idx + 1}</div>
          <div class="q-preview ${previewCls}">${esc(preview)}</div>
        </div>
        <div class="q-item-right">
          ${q._saved ? '<span class="q-saved-badge">✓ Lagra</span>' : ''}
          <button class="btn-delete" onclick="deleteQuestion(event, ${q._localId})" title="Slett">✕</button>
          <span class="chevron">▼</span>
        </div>
      </div>
      <div class="q-body">
        <div class="form-row full">
          <div>
            <label class="field-label">Spørsmål</label>
            <input class="field-input" type="text" placeholder="Skriv spørsmålet her…"
              value="${esc(q.question_text || '')}"
              oninput="updateField(${q._localId}, 'question_text', this.value)" />
          </div>
        </div>

        <div class="form-row full">
          <div>
            <label class="field-label">Bilete-URL (valfritt)</label>
            <input class="field-input" type="url" placeholder="https://example.com/bilete.jpg"
              value="${esc(q.image_url || '')}"
              oninput="updateField(${q._localId}, 'image_url', this.value)" />
          </div>
        </div>

        <div class="options-grid">
          ${['A','B','C','D'].map((letter, i) => `
            <div class="opt-field">
              <span class="opt-label-letter">${letter}</span>
              <input class="opt-input" type="text" placeholder="Alternativ ${letter}"
                value="${esc(q.options[i] || '')}"
                oninput="updateOption(${q._localId}, ${i}, this.value)" />
            </div>
          `).join('')}
        </div>

        <div class="correct-row">
          <label class="field-label" style="margin:0 0 8px">Riktige svar (vel ein eller fleire):</label>
          <div class="correct-checks" id="checks-${q._localId}">
            ${['A','B','C','D'].map((letter, i) => `
              <label class="check-opt">
                <input type="checkbox" class="correct-cb"
                  data-lid="${q._localId}" data-idx="${i}"
                  ${(q.answers||[]).includes(q.options[i]) && q.options[i] ? 'checked' : ''}
                  onchange="toggleAnswer(${q._localId}, ${i}, this.checked)">
                <span class="check-letter">${letter}</span>
                <span class="check-text" id="chktxt-${q._localId}-${i}">${q.options[i] || '(tomt)'}</span>
              </label>
            `).join('')}
          </div>
        </div>

        <button class="btn-save-q" onclick="saveQuestion(${q._localId})">
          Lagre spørsmål
        </button>
      </div>`

    list.appendChild(item)
  })
}

function qrPreviewHtml(q) {
  return '' // QR preview removed – use PDF download instead
}

// ── TOGGLE ──
function toggleItem(el, forceOpen) {
  if (forceOpen) el.classList.add('open')
  else el.classList.toggle('open')

  const lid = parseInt(el.dataset.lid)
  const q   = questions.find(x => x._localId === lid)
  if (q && q._saved && q.id) generateQR(q)
}

// ── UPDATE FIELDS ──
function updateField(lid, field, value) {
  const q = questions.find(x => x._localId === lid)
  if (!q) return
  q[field] = value
  q._saved = false

  if (field === 'question_text') {
    const item = document.querySelector(`[data-lid="${lid}"]`)
    if (item) {
      const preview = item.querySelector('.q-preview')
      preview.textContent = value.trim() || 'Nytt spørsmål…'
      preview.className = 'q-preview' + (value.trim() ? '' : ' empty')
    }
  }
  if (field !== 'answer') refreshCorrectSelect(lid)
}

function updateOption(lid, idx, value) {
  const q = questions.find(x => x._localId === lid)
  if (!q) return
  q.options[idx] = value
  q._saved = false
  refreshCorrectSelect(lid)
}

function refreshCorrectSelect(lid) {
  const q    = questions.find(x => x._localId === lid)
  const item = document.querySelector(`[data-lid="${lid}"]`)
  if (!q || !item) return
  const sel = item.querySelector('.correct-select')
  if (!sel) return
  sel.innerHTML = `<option value="">– vel riktig svar –</option>` +
    ['A','B','C','D'].map((letter, i) => `
      <option value="${esc(q.options[i]||'')}" ${q.answer === q.options[i] ? 'selected':''}>
        ${letter}: ${q.options[i] || '(tomt)'}
      </option>`).join('')
}

// ── TOGGLE CORRECT ANSWER ──
function toggleAnswer(lid, idx, checked) {
  const q = questions.find(x => x._localId === lid)
  if (!q) return
  if (!q.answers) q.answers = []
  const val = q.options[idx]
  if (checked && val && !q.answers.includes(val)) {
    q.answers.push(val)
  } else {
    q.answers = q.answers.filter(a => a !== val)
  }
  q.answer = q.answers[0] || '' // legacy compat
  q._saved = false
}

// ── SAVE QUESTION ──
async function saveQuestion(lid) {
  const q = questions.find(x => x._localId === lid)
  if (!q) return

  if (!(q.question_text || '').trim()) return showToast('⚠️ Skriv inn spørsmålet')
  if (q.options.some(o => !o.trim())) return showToast('⚠️ Fyll inn alle 4 alternativ')
  if (!q.answers || q.answers.length === 0) return showToast('⚠️ Vel minst eitt riktig svar')

  const item = document.querySelector(`[data-lid="${lid}"]`)
  const btn  = item.querySelector('.btn-save-q')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner-sm"></span>Lagrar…'

  // Lagra alle rette svar som JSON i answer-feltet om fleire, elles som tekst
  const answersArr = q.answers && q.answers.length > 0 ? q.answers : [q.answer]
  const answerVal  = answersArr.length === 1
    ? answersArr[0]
    : JSON.stringify(answersArr)

  const payload = {
    major_id:      quizId,
    created_by:    currentUser.id,
    question_text: q.question_text.trim(),
    options:       q.options,
    answer:        answerVal,
    points:        1,
    image_url:     q.image_url || null,
    is_active:     true,
    "order":       questions.indexOf(q),
    updated_at:    new Date().toISOString()
  }

  let saved
  if (q.id) {
    const { data, error } = await db.from('questions').update(payload).eq('id', q.id).select().single()
    if (error) { showToast('❌ Noko gjekk gale: ' + error.message); btn.disabled = false; btn.textContent = 'Lagre spørsmål'; return }
    saved = data
  } else {
    const { data, error } = await db.from('questions').insert(payload).select().single()
    if (error) { showToast('❌ Noko gjekk gale: ' + error.message); btn.disabled = false; btn.textContent = 'Lagre spørsmål'; return }
    saved = data

    await db.from('quizzes').update({
      question_count: questions.filter(x => x.id).length + 1  // +1 for the one being saved now
    }).eq('id', quizId)
  }

  // Oppdater question-objektet som er lagra
  q.id     = saved.id
  q._saved = true

  btn.disabled = false
  btn.textContent = 'Lagre spørsmål'

  showToast('✅ Spørsmål lagra!')

  // Legg til eit nytt tomt spørsmål under, klar for neste
  const newQ = {
    _localId: ++localIdCounter,
    question_text: '',
    options: ['', '', '', ''],
    answers: [],
    answer: '',
    points: 1,
    image_url: '',
    _saved: false
  }
  questions.push(newQ)
  renderList()

  // Scroll til og opne det nye tomme spørsmålet
  setTimeout(() => {
    const el = document.querySelector('[data-lid="' + newQ._localId + '"]')
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      toggleItem(el, true)
    }
  }, 80)
}

// ── DELETE ──
async function deleteQuestion(e, lid) {
  e.stopPropagation()
  if (!confirm('Slett dette spørsmålet?')) return

  const q   = questions.find(x => x._localId === lid)
  const idx = questions.indexOf(q)

  if (q && q.id) {
    await db.from('questions').delete().eq('id', q.id)
  }

  questions.splice(idx, 1)
  renderList()
  showToast('🗑️ Spørsmål sletta')
}

// ── QR CODE ──
function generateQR(q) {
  const container = document.getElementById(`qrcode-${q._localId}`)
  if (!container) return
  container.innerHTML = ''
  new QRCode(container, {
    text:         `${BASE_URL}?id=${q.id}`,
    width:        100,
    height:       100,
    colorDark:    '#111118',
    colorLight:   '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  })
}

// ── LAST NED PDF MED QR-KODAR ──
async function downloadPDF() {
  const saved = questions.filter(q => q._saved && q.id)
  if (saved.length === 0) return showToast('⚠️ Lagre minst eitt spørsmål fyrst')

  const btn = document.querySelector('.btn-pdf')
  btn.disabled = true
  btn.textContent = '⏳ Lagar PDF…'

  const color   = findColor(currentQuiz && currentQuiz.color ? currentQuiz.color : COLORS[0].bg)
  const bgColor = color.bg
  const inkColor = color.ink

  // Generate QR data URLs via hidden canvas
  async function qrDataUrl(url) {
    return new Promise((resolve) => {
      const tmp = document.createElement('div')
      tmp.style.cssText = 'position:fixed;left:-9999px;top:0'
      document.body.appendChild(tmp)
      new QRCode(tmp, { text: url, width: 200, height: 200, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M })
      setTimeout(() => {
        const img = tmp.querySelector('img') || tmp.querySelector('canvas')
        const src = img ? (img.src || img.toDataURL()) : ''
        document.body.removeChild(tmp)
        resolve(src)
      }, 300)
    })
  }

  // A4 dimensions in mm
  const { jsPDF } = window.jspdf
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageW = 210, pageH = 297
  const margin = 10
  const cols = 2, rows = 3
  const cardW = (pageW - margin * 2 - (cols - 1) * 6) / cols
  const cardH = (pageH - margin * 2 - (rows - 1) * 6) / rows

  let page = 0
  for (let i = 0; i < saved.length; i++) {
    const q = saved[i]
    const col = i % cols
    const row = Math.floor((i % (cols * rows)) / cols)
    const card = Math.floor(i / (cols * rows))

    if (i > 0 && i % (cols * rows) === 0) {
      doc.addPage()
    }

    const x = margin + col * (cardW + 6)
    const y = margin + row * (cardH + 6)

    // Print-vennleg kort: kvit bakgrunn med farga ramme (sparer blekk)
    const r = parseInt(bgColor.slice(1,3),16)
    const g = parseInt(bgColor.slice(3,5),16)
    const b = parseInt(bgColor.slice(5,7),16)
    doc.setFillColor(255,255,255)
    doc.roundedRect(x, y, cardW, cardH, 4, 4, 'F')
    doc.setDrawColor(r, g, b)
    doc.setLineWidth(1.2)
    doc.roundedRect(x + 0.6, y + 0.6, cardW - 1.2, cardH - 1.2, 4, 4, 'S')
    doc.setLineWidth(0.2)

    // Stipla klippelinje utanfor ramma
    doc.setDrawColor(170,170,170)
    doc.setLineDash([2,2])
    doc.roundedRect(x - 2, y - 2, cardW + 4, cardH + 4, 4, 4, 'S')
    doc.setLineDash([])

    // QR code centered
    const qrUrl = await qrDataUrl(`${BASE_URL}?id=${q.id}`)
    if (qrUrl) {
      const qrSize = Math.min(cardW, cardH) * 0.55
      const qrX = x + (cardW - qrSize) / 2
      const qrY = y + (cardH - qrSize) / 2 - 2
      // White background behind QR
      doc.setFillColor(255,255,255)
      doc.roundedRect(qrX - 3, qrY - 3, qrSize + 6, qrSize + 6, 2, 2, 'F')
      doc.addImage(qrUrl, 'PNG', qrX, qrY, qrSize, qrSize)
    }

    // Spørsmålsnummer: farga sirkel-badge oppe til venstre
    const num = String(i + 1)
    const ir = parseInt(inkColor.slice(1,3),16)
    const ig = parseInt(inkColor.slice(3,5),16)
    const ib = parseInt(inkColor.slice(5,7),16)
    doc.setFillColor(r, g, b)
    doc.circle(x + 11, y + 11, 7, 'F')
    doc.setTextColor(ir, ig, ib)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(num.length > 1 ? 11 : 13)
    doc.text(num, x + 11, y + 11, { align: 'center', baseline: 'middle' })

    // Tekstlinje nederst: "Spørsmål N"
    doc.setTextColor(17,17,24)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.text(`Spørsmål ${num}`,
      x + cardW / 2, y + cardH - 7,
      { align: 'center', maxWidth: cardW - 10 })
  }

  const quizName = currentQuiz ? currentQuiz.name.replace(/\s+/g,'_') : 'quiz'
  doc.save(`QR_${quizName}.pdf`)

  btn.disabled = false
  btn.textContent = '📥 Last ned QR-PDF'
  showToast('✅ PDF lasta ned!')
}

// ── SCHEDULE ──
function toDatetimeLocal(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function renderScheduleDisplay() {
  const bar = document.getElementById('scheduleBar')
  const display = document.getElementById('scheduleDisplay')
  if (!bar || !display) return
  const s = currentQuiz?.scheduled_start
  const e = currentQuiz?.scheduled_end
  if (!s) {
    display.innerHTML = `<span style="color:var(--muted);font-size:.82rem;">Ingen tidsplan sett</span>`
  } else {
    const fmt = d => new Date(d).toLocaleString('no', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
    display.innerHTML = `<span style="font-size:.85rem;color:var(--ink);">▶ ${fmt(s)}</span>${e ? `<span style="color:var(--muted);">→</span><span style="font-size:.85rem;color:var(--ink);">⏹ ${fmt(e)}</span>` : ''}`
  }
}

window.openScheduleEdit = function () {
  const panel = document.getElementById('scheduleEditPanel')
  const bar   = document.getElementById('scheduleBar')
  if (panel) panel.style.display = 'block'
  if (bar)   bar.style.display   = 'none'
  const ss = document.getElementById('scheduleStartEdit')
  const se = document.getElementById('scheduleEndEdit')
  if (ss) ss.value = toDatetimeLocal(currentQuiz?.scheduled_start)
  if (se) se.value = toDatetimeLocal(currentQuiz?.scheduled_end)
}

window.closeScheduleEdit = function () {
  document.getElementById('scheduleEditPanel').style.display = 'none'
  document.getElementById('scheduleBar').style.display = 'flex'
}

window.saveSchedule = async function () {
  const ssVal = document.getElementById('scheduleStartEdit')?.value
  const seVal = document.getElementById('scheduleEndEdit')?.value
  const updates = {
    scheduled_start: ssVal ? new Date(ssVal).toISOString() : null,
    scheduled_end:   seVal ? new Date(seVal).toISOString() : null
  }
  const { error } = await db.from('quizzes').update(updates).eq('id', quizId)
  if (error) { showToast('❌ Kunne ikkje lagre tidsplan'); return }
  currentQuiz = { ...currentQuiz, ...updates }
  renderScheduleDisplay()
  closeScheduleEdit()
  showToast('📅 Tidsplan lagra!')
}

window.clearSchedule = async function () {
  const { error } = await db.from('quizzes').update({ scheduled_start: null, scheduled_end: null }).eq('id', quizId)
  if (error) { showToast('❌ Feil'); return }
  currentQuiz = { ...currentQuiz, scheduled_start: null, scheduled_end: null }
  renderScheduleDisplay()
  closeScheduleEdit()
  showToast('🗑️ Tidsplan fjerna')
}

// ── TOAST ──
function showToast(msg) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 3000)
}

// ── LOGOUT ──
async function logout() {
  await db.auth.signOut()
  window.location.href = 'login.html'
}

// ── ESCAPE HTML ──
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

init()