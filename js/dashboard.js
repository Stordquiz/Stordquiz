const SUPABASE_URL = 'https://owgldsfxpmzpkipgeksr.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93Z2xkc2Z4cG16cGtpcGdla3NyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MDM2NTYsImV4cCI6MjA5MjM3OTY1Nn0.bD5dNHcQfjjq29DprTnVafxuZeCvt30zu0qQItq6AXY'
const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── FARGEPALETT ──
// Kvar farge har bg (bakgrunn) og ink (skriftfarge med god kontrast)
const COLORS = [
  { name: 'Lime',    bg: '#c8f050', ink: '#111118' },
  { name: 'Grøn',    bg: '#22c55e', ink: '#ffffff' },
  { name: 'Mint',    bg: '#a7f3d0', ink: '#064e3b' },
  { name: 'Blå',     bg: '#3b82f6', ink: '#ffffff' },
  { name: 'Himmel',  bg: '#7dd3fc', ink: '#0c4a6e' },
  { name: 'Indigo',  bg: '#6366f1', ink: '#ffffff' },
  { name: 'Lilla',   bg: '#a855f7', ink: '#ffffff' },
  { name: 'Rosa',    bg: '#ec4899', ink: '#ffffff' },
  { name: 'Fersken', bg: '#fdba74', ink: '#7c2d12' },
  { name: 'Oransje', bg: '#f97316', ink: '#ffffff' },
  { name: 'Raud',    bg: '#ef4444', ink: '#ffffff' },
  { name: 'Vinrød',  bg: '#991b1b', ink: '#ffffff' },
  { name: 'Gul',     bg: '#fde047', ink: '#111118' },
  { name: 'Sand',    bg: '#fef3c7', ink: '#78350f' },
  { name: 'Grå',     bg: '#9ca3af', ink: '#ffffff' },
  { name: 'Svart',   bg: '#1f2937', ink: '#ffffff' }
]

let selectedColor   = COLORS[0]
let allQuizzes      = []
let teachersById    = {}
let currentUser     = null
let isAdmin         = false
let activeQrQuizId  = null
let pendingDeleteId      = null
let activeSessionsByQuiz = {}
let currentSearch   = ''
let activeTag       = null       // null = vis alle

// Hjelp: finn farge-objekt frå lagra bg-verdi
function findColor(bg) {
  return COLORS.find(c => c.bg === bg) || COLORS[0]
}

// ── KATEGORIAR (lagra i quizzes.category i databasen) ──
function getTag(quizId) {
  const q = allQuizzes.find(x => x.id === quizId)
  return (q && q.category) || ''
}

// Set kategori på ein quiz (null/tom streng fjernar)
async function setTag(quizId, tag) {
  const clean = (tag || '').trim() || null
  const { error } = await db.from('quizzes').update({ category: clean }).eq('id', quizId)
  if (error) { console.error('setTag:', error); return false }
  const q = allQuizzes.find(x => x.id === quizId)
  if (q) q.category = clean
  return true
}

// Alle unike kategorinamn (sortert)
function getAllCategories() {
  const set = new Set(allQuizzes.map(q => q.category).filter(Boolean))
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'no'))
}

// Tel kor mange quizzar som har kvar kategori
function countByCategory() {
  const counts = {}
  allQuizzes.forEach(q => {
    if (q.category) counts[q.category] = (counts[q.category] || 0) + 1
  })
  return counts
}

// Endre namn på ein kategori (alle synlege quizzar med gammalt namn får nytt)
async function renameCategory(oldName, newName) {
  const clean = (newName || '').trim()
  if (!clean || clean === oldName) return false
  const ids = allQuizzes.filter(q => q.category === oldName).map(q => q.id)
  if (ids.length === 0) return false
  const { error } = await db.from('quizzes').update({ category: clean }).in('id', ids)
  if (error) { console.error('renameCategory:', error); return false }
  allQuizzes.forEach(q => { if (q.category === oldName) q.category = clean })
  return true
}

// Fjern kategori frå alle synlege quizzar
async function deleteCategory(name) {
  const ids = allQuizzes.filter(q => q.category === name).map(q => q.id)
  if (ids.length === 0) return false
  const { error } = await db.from('quizzes').update({ category: null }).in('id', ids)
  if (error) { console.error('deleteCategory:', error); return false }
  allQuizzes.forEach(q => { if (q.category === name) q.category = null })
  return true
}

// Eingongs-migrering: flytt gamle localStorage-kategoriar inn i databasen
async function migrateLocalTags() {
  const TAG_KEY = 'quiz_tags_v1'
  let map = null
  try { map = JSON.parse(localStorage.getItem(TAG_KEY) || 'null') } catch {}
  if (!map) return
  for (const [qid, tag] of Object.entries(map)) {
    const q = allQuizzes.find(x => x.id === qid)
    if (q && tag && !q.category) {
      const { error } = await db.from('quizzes').update({ category: tag }).eq('id', qid)
      if (!error) q.category = tag
    }
  }
  localStorage.removeItem(TAG_KEY)
}

// ── INIT ──
async function init() {
  const { data } = await db.auth.getSession()
  if (!data.session) { window.location.href = 'login.html'; return }

  currentUser = data.session.user
  document.body.classList.add('app-ready')   // auth OK → vis sida
  document.getElementById('userEmail').textContent   = currentUser.email.split('@')[0]
  document.getElementById('userInitial').textContent = currentUser.email[0].toUpperCase()

  // Sjekk om brukaren er admin (men IKKJE vis merke)
  const { data: me } = await db
    .from('teachers')
    .select('is_admin')
    .eq('id', currentUser.id)
    .single()
  isAdmin = !!(me && me.is_admin)

  buildColorGrid()
  loadQuizzes()
}

// ── COLOR GRID ──
function buildColorGrid() {
  renderColorGrid('colorGrid', COLORS[0].bg, c => { selectedColor = c })
}

// Teiknar ein fargevelgar i gitt element. Valet gjeld berre innanfor dette gridet.
function renderColorGrid(gridId, selectedBg, onSelect) {
  const grid = document.getElementById(gridId)
  if (!grid) return
  grid.innerHTML = ''
  COLORS.forEach(c => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'color-btn' + (c.bg === selectedBg ? ' selected' : '')
    btn.style.background = c.bg
    btn.title = c.name
    btn.setAttribute('aria-label', c.name)
    btn.onclick = () => {
      grid.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'))
      btn.classList.add('selected')
      onSelect(c)
    }
    grid.appendChild(btn)
  })
}

// ── LOAD QUIZZES ──
async function loadQuizzes() {
  try {
    let query = db.from('quizzes').select('id,name,color,category,question_count,session_count,scheduled_start,scheduled_end,teacher_id,created_at').order('created_at', { ascending: false })
    if (!isAdmin) query = query.eq('teacher_id', currentUser.id)

    const { data, error } = await query
    if (error) throw error
    allQuizzes = data || []

    if (isAdmin && allQuizzes.length > 0) {
      const ids = [...new Set(allQuizzes.map(q => q.teacher_id).filter(Boolean))]
      if (ids.length > 0) {
        const { data: teachers } = await db
          .from('teachers')
          .select('id, email, full_name')
          .in('id', ids)
        teachersById = {}
        ;(teachers || []).forEach(t => { teachersById[t.id] = t })
      }
    }
  } catch (err) {
    console.error('Kunne ikkje hente quizzar:', err)
    allQuizzes = []
  }

  // Fetch active/waiting sessions for this teacher
  if (currentUser) {
    try {
      const { data: activeSessions } = await db
        .from('sessions')
        .select('id, quiz_id, join_code, status, started_at')
        .eq('host_id', currentUser.id)
        .in('status', ['waiting', 'active'])
        .order('started_at', { ascending: false, nullsFirst: true })
      activeSessionsByQuiz = {}
      ;(activeSessions || []).forEach(s => {
        if (!activeSessionsByQuiz[s.quiz_id]) activeSessionsByQuiz[s.quiz_id] = s
      })
    } catch(e) { console.error('Sessions fetch error', e) }
  }

  await migrateLocalTags()

  updateHeaderStats()
  renderTagChips()
  applyFilters()
}

// ── RENDER QUIZ CARDS ──
function renderQuizzes(list) {
  const grid = document.getElementById('quizGrid')
  grid.innerHTML = ''

  if (list.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🗺️</div>
        <div class="empty-title">${allQuizzes.length === 0 ? 'Ingen quizzar enno' : 'Fann ingen quizzar'}</div>
        <div class="empty-desc">${allQuizzes.length === 0 ? 'Trykk «Ny quiz» for å kome i gang med ditt første rebusløp.' : 'Prøv eit anna søk eller fjern filter.'}</div>
      </div>`
    return
  }

  list.forEach(q => {
    const card = document.createElement('div')
    card.className = 'quiz-card'

    // Hent farge frå quiz (fallback til lime)
    const color    = findColor(q.color || COLORS[0].bg)
    const bgColor  = color.bg
    const inkColor = color.ink
    const tag      = getTag(q.id)
    const isActive = q.status === 'active'

    card.style.setProperty('--quiz-bg',  bgColor)
    card.style.setProperty('--quiz-ink', inkColor)

    const date = new Date(q.created_at).toLocaleDateString('no', {
      day: 'numeric', month: 'short', year: 'numeric'
    })

    const nameEsc = escAttr(q.name)
    const now = new Date()
    const schedStart = q.scheduled_start ? new Date(q.scheduled_start) : null
    const schedEnd   = q.scheduled_end   ? new Date(q.scheduled_end)   : null
    const isScheduled = schedStart && !isActive
    const isOverdue   = isScheduled && schedStart < now  // scheduled time has passed but not started
    let scheduleBadge = ''
    if (isScheduled) {
      const label = isOverdue
        ? `⏰ Planlagt ${formatScheduleDate(q.scheduled_start)}`
        : `📅 ${formatScheduleDate(q.scheduled_start)}`
      const badgeColor = isOverdue ? '#f0c050' : '#4d9fff'
      scheduleBadge = `<span style="font-size:.72rem;padding:.15rem .5rem;border-radius:6px;background:${badgeColor}22;color:${badgeColor};border:1px solid ${badgeColor}66;white-space:nowrap;">${label}</span>`
    }

    card.innerHTML = `
      <div class="quiz-color-stripe"></div>
      <div class="quiz-card-inner">
        <button class="quiz-menu-btn" aria-label="Meir" data-quiz-id="${q.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
          </svg>
        </button>
        <div class="quiz-menu-pop" data-menu-for="${q.id}">
          <button class="quiz-menu-item" data-action="rename" data-quiz-id="${q.id}">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            Endre namn
          </button>
          <button class="quiz-menu-item" data-action="color" data-quiz-id="${q.id}">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9"/>
              <circle cx="8.5" cy="10" r="1.2" fill="currentColor"/>
              <circle cx="12" cy="7.5" r="1.2" fill="currentColor"/>
              <circle cx="15.5" cy="10" r="1.2" fill="currentColor"/>
            </svg>
            Endre farge
          </button>
          <button class="quiz-menu-item" data-action="category" data-quiz-id="${q.id}">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
              <line x1="7" y1="7" x2="7.01" y2="7"/>
            </svg>
            Endre kategori
          </button>
          <button class="quiz-menu-item danger" data-action="delete" data-quiz-id="${q.id}" data-quiz-name="${nameEsc}">
            <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
            Slett quiz
          </button>
        </div>
        <div class="quiz-header">
          <span class="quiz-name">${escHtml(q.name)}</span>
          <div class="quiz-meta">
            ${isActive ? '<span><span class="quiz-active-dot"></span>Aktiv</span>' : `<span>Oppretta ${date}</span>`}
            ${scheduleBadge}
            ${tag ? `<span class="quiz-tag">${escHtml(tag)}</span>` : ''}
          </div>
        </div>
        <div class="quiz-card-body">
          <div class="quiz-stats-mid">
            <div class="quiz-stat-mid">
              <span class="stat-num">${q.question_count || 0}</span>
              <span class="stat-lbl">spørsmål</span>
            </div>
          </div>
          <div class="quiz-card-footer">
            <a class="btn-open" href="quiz.html?id=${q.id}">Rediger</a>
            ${activeSessionsByQuiz[q.id]
              ? `<button class="btn-host btn-rejoin" data-quiz-id="${q.id}" title="PIN: ${activeSessionsByQuiz[q.id].join_code}">${activeSessionsByQuiz[q.id].status === 'active' ? '🏃' : '⏳'} Fortset · ${activeSessionsByQuiz[q.id].join_code}</button><button class="btn-end-session" data-quiz-id="${q.id}" data-session-id="${activeSessionsByQuiz[q.id].id}" title="Avslutt økt">✕</button>`
              : `<button class="btn-host" data-quiz-id="${q.id}">▶ Start</button>`
            }
          </div>
        </div>
      </div>`

    // Klikk på kortet (utanom footer/meny) → opne quizen
    card.addEventListener('click', (e) => {
      if (e.target.closest('.quiz-card-footer')) return
      if (e.target.closest('.quiz-menu-btn'))   return
      if (e.target.closest('.quiz-menu-pop'))   return
      window.location.href = `quiz.html?id=${q.id}`
    })

    // ...-meny opnar/lukkar
    const menuBtn = card.querySelector('.quiz-menu-btn')
    const menuPop = card.querySelector('.quiz-menu-pop')
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // lukk andre opne menyar
      document.querySelectorAll('.quiz-menu-pop.open').forEach(p => {
        if (p !== menuPop) p.classList.remove('open')
      })
      menuPop.classList.toggle('open')
    })

    // namn- og farge-handling i meny
    menuPop.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
      e.stopPropagation()
      menuPop.classList.remove('open')
      openEditModal(q.id, 'name')
    })
    menuPop.querySelector('[data-action="color"]').addEventListener('click', (e) => {
      e.stopPropagation()
      menuPop.classList.remove('open')
      openEditModal(q.id, 'color')
    })

    // kategori-handling i meny
    menuPop.querySelector('[data-action="category"]').addEventListener('click', (e) => {
      e.stopPropagation()
      menuPop.classList.remove('open')
      openCategoryModal(q.id)
    })

    // slett-handling i meny
    menuPop.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation()
      const b = e.currentTarget
      menuPop.classList.remove('open')
      askDeleteQuiz(b.dataset.quizId, b.dataset.quizName)
    })

    card.querySelector('.btn-host').addEventListener('click', (e) => {
      e.stopPropagation()
      window.location.href = `host.html?quiz=${e.currentTarget.dataset.quizId}`
    })

    const endBtn = card.querySelector('.btn-end-session')
    if (endBtn) {
      endBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (!confirm('Vil du avslutte denne aktive økta?')) return
        const sid = e.currentTarget.dataset.sessionId
        const qid = e.currentTarget.dataset.quizId
        const { error } = await db.from('sessions')
          .update({ status: 'finished', ended_at: new Date().toISOString() })
          .eq('id', sid)
        if (error) { showToast('❌ Kunne ikkje avslutte: ' + error.message); return }
        localStorage.removeItem('host_session_' + qid)
        delete activeSessionsByQuiz[qid]
        applyFilters()
        updateHeaderStats()
        showToast('✅ Økt avslutta')
      })
    }

    grid.appendChild(card)
  })
}

// Lukk meny ved klikk utanfor
document.addEventListener('click', () => {
  document.querySelectorAll('.quiz-menu-pop.open').forEach(p => p.classList.remove('open'))
})

// ── HEADER-STATS (samandrag i subtitle) ──
function updateHeaderStats() {
  const total  = allQuizzes.length
  const active = typeof activeSessionsByQuiz !== "undefined" ? Object.keys(activeSessionsByQuiz).length : 0
  const sub = document.getElementById('pageSubtitle')
  if (!sub) return
  if (total === 0) {
    sub.textContent = 'Opprett din første quiz med knappen til høgre.'
    return
  }
  const quizWord = total === 1 ? 'quiz' : 'quizzar'
  let html = `Du har <strong>${total}</strong> ${quizWord}`
  if (active > 0) {
    html += ` · <span class="subtitle-dot"></span><strong>${active}</strong> aktiv${active === 1 ? '' : 'e'} no`
  }
  sub.innerHTML = html
}

// ── TAG-CHIPS over grid ──
function renderTagChips() {
  const wrap = document.getElementById('tagChips')
  wrap.innerHTML = ''
  // tel kor mange quizzar per kategori (berre dei brukaren ser)
  const counts = countByCategory()
  const tags = Object.keys(counts).sort((a, b) => a.localeCompare(b, 'no'))

  // Administrer-knapp: berre vis om det finst kategoriar overhovudet
  const mgBtn = document.getElementById('btnManageTags')
  if (mgBtn) mgBtn.style.display = getAllCategories().length > 0 ? '' : 'none'

  if (tags.length === 0) return

  // "Alle"-chip
  const all = document.createElement('button')
  all.className = 'tag-chip' + (activeTag === null ? ' active' : '')
  all.innerHTML = `Alle <span class="tag-count">${allQuizzes.length}</span>`
  all.onclick = () => { activeTag = null; renderTagChips(); applyFilters() }
  wrap.appendChild(all)

  tags.forEach(t => {
    const chip = document.createElement('button')
    chip.className = 'tag-chip' + (activeTag === t ? ' active' : '')
    chip.innerHTML = `${escHtml(t)} <span class="tag-count">${counts[t]}</span>`
    chip.onclick = () => { activeTag = (activeTag === t ? null : t); renderTagChips(); applyFilters() }
    wrap.appendChild(chip)
  })
}

// ── KATEGORI-DROPDOWN i opprett-modal ──
function populateCategorySelect() {
  const sel = document.getElementById('newTagSelect')
  if (!sel) return
  const cats = getAllCategories()
  // Behald første ("Ingen kategori") og siste ("+ Ny kategori...")
  sel.innerHTML = ''
  sel.appendChild(new Option('— Ingen kategori —', ''))
  cats.forEach(c => sel.appendChild(new Option(c, c)))
  sel.appendChild(new Option('+ Ny kategori…', '__new__'))
  sel.value = ''
  // Skjul nytt-rad om opent
  const row = document.getElementById('tagNewRow')
  if (row) row.style.display = 'none'
  const inp = document.getElementById('newTag')
  if (inp) inp.value = ''
}

function onTagSelectChange(value) {
  const row = document.getElementById('tagNewRow')
  const inp = document.getElementById('newTag')
  if (value === '__new__') {
    row.style.display = ''
    setTimeout(() => inp && inp.focus(), 50)
  } else {
    row.style.display = 'none'
    if (inp) inp.value = ''
  }
}

function cancelNewTag() {
  const sel = document.getElementById('newTagSelect')
  if (sel) sel.value = ''
  const row = document.getElementById('tagNewRow')
  if (row) row.style.display = 'none'
  const inp = document.getElementById('newTag')
  if (inp) inp.value = ''
}

// Returner valt kategori (frå dropdown eller nytt-input)
function getSelectedTagFromModal() {
  const sel = document.getElementById('newTagSelect')
  if (!sel) return ''
  if (sel.value === '__new__') {
    const inp = document.getElementById('newTag')
    return inp ? inp.value.trim() : ''
  }
  return sel.value || ''
}

// ── ADMINISTRER-MODAL ──
function openManageModal() {
  document.getElementById('manageOverlay').classList.add('open')
  renderCategoryList()
}
function closeManageModal() {
  document.getElementById('manageOverlay').classList.remove('open')
}
function closeManageModalIfBg(e) {
  if (e.target === document.getElementById('manageOverlay')) closeManageModal()
}

function renderCategoryList() {
  const list = document.getElementById('categoryList')
  if (!list) return
  list.innerHTML = ''

  const cats   = getAllCategories()
  const counts = countByCategory()

  if (cats.length === 0) {
    list.innerHTML = `<div class="category-empty">Du har ingen kategoriar enno.<br>Lag ein ved å opprette ein quiz med kategori.</div>`
    return
  }

  cats.forEach(name => {
    const row = document.createElement('div')
    row.className = 'category-row'
    row.dataset.name = name

    row.innerHTML = `
      <span class="category-name">${escHtml(name)}</span>
      <span class="category-count">${counts[name] || 0} quiz${counts[name] === 1 ? '' : 'zar'}</span>
      <button class="cat-icon-btn" data-action="edit" title="Endre namn">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
      <button class="cat-icon-btn danger" data-action="delete" title="Slett kategori">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
      </button>`

    row.querySelector('[data-action="edit"]').onclick = () => startEditCategory(row, name)
    row.querySelector('[data-action="delete"]').onclick = () => askDeleteCategory(name)

    list.appendChild(row)
  })
}

function startEditCategory(row, oldName) {
  row.innerHTML = `
    <input class="category-name-input" type="text" value="${escAttr(oldName)}" maxlength="24" />
    <button class="cat-icon-btn save" data-action="save" title="Lagre">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </button>
    <button class="cat-icon-btn" data-action="cancel" title="Avbryt">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>`
  const input = row.querySelector('input')
  input.focus()
  input.select()

  const commit = async () => {
    const newName = input.value.trim()
    if (!newName || newName === oldName) return renderCategoryList()
    // Hindra kollisjon med eksisterande namn (då samanslår vi)
    if (await renameCategory(oldName, newName)) {
      showToast(`✏️ Endra til "${newName}"`)
      // Hald activeTag synkronisert om brukaren filtrerte på det gamle namnet
      if (activeTag === oldName) activeTag = newName
      renderCategoryList()
      renderTagChips()
      applyFilters()
    } else {
      renderCategoryList()
    }
  }
  row.querySelector('[data-action="save"]').onclick = commit
  row.querySelector('[data-action="cancel"]').onclick = () => renderCategoryList()
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') renderCategoryList()
  })
}

async function askDeleteCategory(name) {
  const counts = countByCategory()
  const n = counts[name] || 0
  const msg = n > 0
    ? `Slette kategorien "${name}"?\n${n} quiz${n === 1 ? '' : 'zar'} blir utan kategori.`
    : `Slette kategorien "${name}"?`
  if (!confirm(msg)) return
  await deleteCategory(name)
  if (activeTag === name) activeTag = null
  showToast(`🗑️ Sletta "${name}"`)
  renderCategoryList()
  renderTagChips()
  applyFilters()
}

// ── ENDRE KATEGORI MODAL (for eksisterande quizzar) ──
let categoryEditQuizId = null

function openCategoryModal(quizId) {
  categoryEditQuizId = quizId
  const q = allQuizzes.find(x => x.id === quizId)
  document.getElementById('categoryModalDesc').innerHTML =
    `Vel kategori for <strong style="color:var(--ink)">${escHtml(q ? q.name : '')}</strong>`

  const sel = document.getElementById('catEditSelect')
  sel.innerHTML = ''
  sel.appendChild(new Option('— Ingen kategori —', ''))
  getAllCategories().forEach(c => sel.appendChild(new Option(c, c)))
  sel.appendChild(new Option('+ Ny kategori…', '__new__'))
  sel.value = (q && q.category) || ''

  document.getElementById('catEditNewRow').style.display = 'none'
  document.getElementById('catEditNew').value = ''
  document.getElementById('categoryOverlay').classList.add('open')
}

function closeCategoryModal() {
  document.getElementById('categoryOverlay').classList.remove('open')
  categoryEditQuizId = null
}
function closeCategoryModalIfBg(e) {
  if (e.target === document.getElementById('categoryOverlay')) closeCategoryModal()
}

function onCatEditSelectChange(value) {
  const row = document.getElementById('catEditNewRow')
  const inp = document.getElementById('catEditNew')
  if (value === '__new__') {
    row.style.display = ''
    setTimeout(() => inp && inp.focus(), 50)
  } else {
    row.style.display = 'none'
    if (inp) inp.value = ''
  }
}

function cancelCatEditNew() {
  const sel = document.getElementById('catEditSelect')
  if (sel) sel.value = ''
  document.getElementById('catEditNewRow').style.display = 'none'
  document.getElementById('catEditNew').value = ''
}

async function saveCategoryModal() {
  if (!categoryEditQuizId) return
  const sel = document.getElementById('catEditSelect')
  let val = sel.value
  if (val === '__new__') val = document.getElementById('catEditNew').value.trim()

  const btn = document.getElementById('catEditSaveBtn')
  btn.disabled = true
  btn.textContent = 'Lagrar…'

  const ok = await setTag(categoryEditQuizId, val)

  btn.disabled = false
  btn.textContent = 'Lagre'

  if (ok) {
    renderTagChips()
    applyFilters()
    showToast(val ? `🏷️ Kategori sett til "${val}"` : '🏷️ Kategori fjerna')
  } else {
    showToast('❌ Kunne ikkje lagre kategori')
  }
  closeCategoryModal()
}

// ── ENDRE NAMN OG FARGE MODAL ──
let editQuizId = null
let editColor  = COLORS[0]

function openEditModal(quizId, focus) {
  const q = allQuizzes.find(x => x.id === quizId)
  if (!q) return
  editQuizId = quizId
  editColor  = findColor(q.color || COLORS[0].bg)

  const nameInput = document.getElementById('editName')
  nameInput.value = q.name || ''
  renderColorGrid('editColorGrid', editColor.bg, c => { editColor = c })

  document.getElementById('editOverlay').classList.add('open')
  if (focus === 'name') {
    setTimeout(() => { nameInput.focus(); nameInput.select() }, 150)
  }
}

function closeEditModal() {
  document.getElementById('editOverlay').classList.remove('open')
  editQuizId = null
}
function closeEditModalIfBg(e) {
  if (e.target === document.getElementById('editOverlay')) closeEditModal()
}

async function saveEditModal() {
  if (!editQuizId) return
  const q = allQuizzes.find(x => x.id === editQuizId)
  if (!q) return closeEditModal()

  const nameInput = document.getElementById('editName')
  const newName = nameInput.value.trim()
  if (!newName) { nameInput.focus(); return }

  const changes = {}
  if (newName !== q.name) changes.name = newName
  if (editColor.bg !== (q.color || COLORS[0].bg)) changes.color = editColor.bg
  if (Object.keys(changes).length === 0) return closeEditModal()

  const btn = document.getElementById('editSaveBtn')
  btn.disabled = true
  btn.textContent = 'Lagrar…'

  // .select() gjer at vi oppdagar om databasen (RLS) stille avviste oppdateringa
  const { data, error } = await db.from('quizzes').update(changes).eq('id', editQuizId).select('id')

  btn.disabled = false
  btn.textContent = 'Lagre'

  if (error || !data || data.length === 0) {
    console.error('saveEditModal:', error)
    showToast('❌ Kunne ikkje lagre endringa' + (error ? ': ' + error.message : ''))
    return
  }

  Object.assign(q, changes)
  applyFilters()
  closeEditModal()
  showToast('✏️ Quiz oppdatert')
}

// ── SEARCH + TAG-FILTER ──
function applyFilters() {
  const term = currentSearch.toLowerCase()

  const list = allQuizzes.filter(q => {
    const nameOk = !term || (q.name || '').toLowerCase().includes(term)
    const tagOk  = !activeTag || q.category === activeTag
    return nameOk && tagOk
  })

  renderQuizzes(list)
}

// ── SEARCH ──
function filterQuizzes(q) {
  currentSearch = q || ''
  applyFilters()
}

// ── CREATE MODAL ──
function openModal() {
  populateCategorySelect()
  document.getElementById('modalOverlay').classList.add('open')
  setTimeout(() => document.getElementById('newName').focus(), 150)
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open')
  document.getElementById('newName').value = ''
  cancelNewTag()
  const sel = document.getElementById('newTagSelect')
  if (sel) sel.value = ''
  const tog = document.getElementById('scheduleToggle')
  if (tog) tog.checked = false
  toggleScheduleFields(false)
  const ss = document.getElementById('scheduleStart'); if (ss) ss.value = ''
  const se = document.getElementById('scheduleEnd');   if (se) se.value = ''
}

window.toggleScheduleFields = function(show) {
  const el = document.getElementById('scheduleFields')
  if (el) el.style.display = show ? 'block' : 'none'
}
function closeModalIfBg(e) {
  if (e.target === document.getElementById('modalOverlay')) closeModal()
}

// ── QR MODAL ──
function openQrModal(quizId, quizName, bgColor, inkColor) {
  activeQrQuizId = quizId

  // Bruk farge i tittelen som ein liten fargeprikk
  const titleEl = document.getElementById('qrModalTitle')
  titleEl.innerHTML = `<span class="qr-modal-dot" style="background:${bgColor}"></span>${escHtml(quizName)}`

  const base  = window.location.origin + window.location.pathname.replace('dashboard.html', '')
  const qrUrl = `${base}index.html`
  document.getElementById('qrUrl').textContent = qrUrl

  // Set bakgrunn på QR-wrapen til quiz-fargen
  const wrap = document.getElementById('qrCanvasWrap')
  wrap.style.background = bgColor

  // Bestem QR-modulfarge ut frå kontrast (mørke fargar → lyse moduler funkar dårleg for skanning,
  // så vi held QR-koden alltid mørk på lys bakgrunn inni eit kvit-kort, og bruker quizfargen som ramme)
  const canvas = document.getElementById('qrCanvas')
  QRCode.toCanvas(canvas, qrUrl, {
    width: 200,
    margin: 2,
    color: { dark: '#111118', light: '#ffffff' }
  }, err => { if (err) console.error(err) })

  document.getElementById('qrModalOverlay').classList.add('open')
}
function closeQrModal() {
  document.getElementById('qrModalOverlay').classList.remove('open')
  activeQrQuizId = null
}
function closeQrModalIfBg(e) {
  if (e.target === document.getElementById('qrModalOverlay')) closeQrModal()
}
function downloadQr() {
  const canvas = document.getElementById('qrCanvas')
  const quiz   = allQuizzes.find(q => q.id === activeQrQuizId)
  const name   = quiz ? quiz.name.replace(/\s+/g, '_') : 'quiz'
  const link   = document.createElement('a')
  link.download = `QR_${name}.png`
  link.href     = canvas.toDataURL('image/png')
  link.click()
  showToast('📥 QR-kode lasta ned!')
}

// ── DELETE QUIZ ──
function askDeleteQuiz(quizId, quizName) {
  pendingDeleteId = quizId
  document.getElementById('deleteQuizName').textContent = quizName
  document.getElementById('deleteOverlay').classList.add('open')
}
function closeDeleteModal() {
  document.getElementById('deleteOverlay').classList.remove('open')
  pendingDeleteId = null
}
function closeDeleteModalIfBg(e) {
  if (e.target === document.getElementById('deleteOverlay')) closeDeleteModal()
}

async function confirmDeleteQuiz() {
  if (!pendingDeleteId) return
  const id  = pendingDeleteId
  const btn = document.getElementById('deleteConfirmBtn')
  btn.disabled = true
  btn.textContent = 'Slettar…'

  try {
    const { error } = await db.from('quizzes').delete().eq('id', id)
    if (error) throw error

    allQuizzes = allQuizzes.filter(q => q.id !== id)
    updateHeaderStats()
    renderTagChips()
    applyFilters()
    showToast('🗑️ Quiz sletta')
  } catch (err) {
    console.error(err)
    showToast('❌ Kunne ikkje slette: ' + (err.message || 'ukjend feil'))
  } finally {
    btn.disabled = false
    btn.textContent = 'Slett quiz'
    closeDeleteModal()
  }
}

// ── CREATE QUIZ ──
async function createQuiz() {
  const name = document.getElementById('newName').value.trim()
  if (!name) { document.getElementById('newName').focus(); return }

  const btn = document.getElementById('submitBtn')
  btn.disabled = true
  btn.textContent = 'Oppretter…'

  const ssEl = document.getElementById('scheduleStart')
  const seEl = document.getElementById('scheduleEnd')
  const scheduledStart = ssEl?.value ? new Date(ssEl.value).toISOString() : null
  const scheduledEnd   = seEl?.value ? new Date(seEl.value).toISOString() : null

  const newQuiz = {
    name,
    color:            selectedColor.bg,
    teacher_id:       currentUser.id,
    status:           'draft',
    created_at:       new Date().toISOString(),
    question_count:   0,
    session_count:    0,
    scheduled_start:  scheduledStart,
    scheduled_end:    scheduledEnd,
    category:         getSelectedTagFromModal() || null
  }

  try {
    const { data, error } = await db.from('quizzes').insert(newQuiz).select().single()
    if (error) throw error
    allQuizzes.unshift(data)
    updateHeaderStats()
    renderTagChips()
    applyFilters()
    closeModal()
    showToast('✅ Quiz oppretta!')
  } catch (err) {
    console.error(err)
    showToast('❌ Kunne ikkje opprette quiz: ' + (err.message || ''))
  }

  btn.disabled = false
  btn.textContent = 'Opprett quiz'
}

// ── SCHEDULE HELPERS ──
function formatScheduleDate(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const isTomorrow = d.toDateString() === new Date(now.getTime() + 86400000).toDateString()
  const timeStr = d.toLocaleTimeString('no', { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `i dag kl. ${timeStr}`
  if (isTomorrow) return `i morgon kl. ${timeStr}`
  return d.toLocaleDateString('no', { day: 'numeric', month: 'short' }) + ` kl. ${timeStr}`
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

// ── ESCAPE HELPERS ──
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;')
}
function escAttr(str) {
  return escHtml(str)
}

// ── KEYBOARD ──
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal()
    closeQrModal()
    closeDeleteModal()
    closeManageModal()
    closeCategoryModal()
    closeEditModal()
  }
  if (e.key === 'Enter' && document.getElementById('editOverlay').classList.contains('open')) {
    e.preventDefault()
    saveEditModal()
    return
  }
  if (e.key === 'Enter' && document.getElementById('modalOverlay').classList.contains('open')) {
    // Ikkje submit om brukaren skriv i ny-tag-feltet (då skal Enter lukka det)
    const newTag = document.getElementById('newTag')
    if (newTag && document.activeElement === newTag) return
    createQuiz()
  }
})

// Eksponer for inline onclick i HTML
window.openModal              = openModal
window.closeModal             = closeModal
window.closeModalIfBg         = closeModalIfBg
window.closeQrModal           = closeQrModal
window.closeQrModalIfBg       = closeQrModalIfBg
window.downloadQr             = downloadQr
window.createQuiz             = createQuiz
window.filterQuizzes          = filterQuizzes
window.logout                 = logout
window.confirmDeleteQuiz      = confirmDeleteQuiz
window.closeDeleteModal       = closeDeleteModal
window.closeDeleteModalIfBg   = closeDeleteModalIfBg
window.onTagSelectChange      = onTagSelectChange
window.cancelNewTag           = cancelNewTag
window.openManageModal        = openManageModal
window.closeManageModal       = closeManageModal
window.closeManageModalIfBg   = closeManageModalIfBg
window.closeCategoryModal     = closeCategoryModal
window.closeCategoryModalIfBg = closeCategoryModalIfBg
window.onCatEditSelectChange  = onCatEditSelectChange
window.cancelCatEditNew       = cancelCatEditNew
window.saveCategoryModal      = saveCategoryModal
window.closeEditModal         = closeEditModal
window.closeEditModalIfBg     = closeEditModalIfBg
window.saveEditModal          = saveEditModal

init()