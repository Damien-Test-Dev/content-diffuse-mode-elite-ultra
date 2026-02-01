const INDEX_URL = "./index.json";
const ALERTS_URL = "./alerts.json";
const BATCH_SIZE = 20; // scroll infini

const els = {
  metaNow: document.getElementById("metaNow"),
  alerts: document.getElementById("alerts"),
  hero: document.getElementById("heroRotator"),
  week: document.getElementById("weekGrid"),
  feed: document.getElementById("feed"),
  sentinel: document.getElementById("sentinel"),
};

function parisISODate(d = new Date()){
  // ex: "2026-02-01"
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
}

function isWeekdayISO(iso){
  const dt = new Date(iso + "T12:00:00Z"); // stable
  const day = dt.getUTCDay(); // 0..6 (dim..sam)
  return day >= 1 && day <= 5;
}

function cmp(a,b){ return a < b ? -1 : a > b ? 1 : 0; }

function statusFor(dateISO, todayISO){
  if (cmp(dateISO, todayISO) < 0) return "published";
  if (dateISO === todayISO) return "today";
  return "incoming";
}

function badgeHTML(status){
  if (status === "published") return `<span class="badge published">PUBLISHED</span>`;
  if (status === "today") return `<span class="badge today">TODAY</span>`;
  return `<span class="badge incoming">INCOMING</span>`;
}

function renderPostCard(p, todayISO){
  const st = statusFor(p.date, todayISO);
  const blurClass = st === "incoming" ? "is-future" : "";

  return `
  <article class="post ${blurClass}">
    <div class="post-head">
      <div>
        <div class="post-date">${p.date}</div>
      </div>
      <div class="badges">
        ${badgeHTML(st)}
        ${st === "today" ? `<span class="badge published">READY</span>` : ``}
      </div>
    </div>
    <div class="post-body">
      <div class="post-img">
        <img src="${p.image_url}" alt="image ${p.date}" loading="lazy" />
      </div>
      <div class="post-text">${escapeHTML(p.text)}</div>
    </div>
  </article>`;
}

function escapeHTML(s){
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Semaine en cours (lun..ven) en timezone Paris
function weekDates(todayISO){
  const dt = new Date(todayISO + "T12:00:00Z");
  const dow = dt.getUTCDay(); // 1..5 weekdays
  const monday = new Date(dt);
  const diff = (dow === 0 ? 6 : dow - 1);
  monday.setUTCDate(monday.getUTCDate() - diff);

  const out = [];
  for(let i=0;i<5;i++){
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    const iso = d.toISOString().slice(0,10);
    out.push(iso);
  }
  return out;
}

function renderWeek(postsByDate, todayISO){
  const dates = weekDates(todayISO);
  els.week.innerHTML = dates.map(iso => {
    const p = postsByDate.get(iso);
    const st = statusFor(iso, todayISO);
    const label = st === "published" ? "Published" : st === "today" ? "Today" : "Incoming";
    const img = p ? `<div class="week-mini"><img src="${p.image_url}" alt=""></div>` : ``;
    const note = p ? `OK` : `MISSING`;
    return `
      <div class="week-card">
        <div class="week-date">${iso}</div>
        <div class="week-status">${label} • ${note}</div>
        ${img}
      </div>`;
  }).join("");
}

function renderHero(postsSorted, todayISO){
  // 3 cartes : today, prochaine, précédente (si dispo)
  const byDate = new Map(postsSorted.map(p => [p.date, p]));
  const today = byDate.get(todayISO);
  const next = postsSorted.find(p => cmp(p.date, todayISO) > 0);
  const prev = [...postsSorted].reverse().find(p => cmp(p.date, todayISO) < 0);

  const picks = [today, next, prev].filter(Boolean).slice(0,3);
  if (picks.length === 0){
    els.hero.innerHTML = `<div class="hint">Aucun contenu indexé.</div>`;
    return;
  }

  els.hero.innerHTML = picks.map(p => `
    <div class="card">
      <div class="content">
        <img src="${p.image_url}" alt="">
      </div>
    </div>
  `).join("");
}

async function loadJSON(url){
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return r.json();
}

async function main(){
  const todayISO = parisISODate();
  els.metaNow.textContent = `Today (Paris): ${todayISO}`;

  // alerts (optionnel)
  try{
    const a = await loadJSON(ALERTS_URL);
    if (a?.messages?.length){
      els.alerts.hidden = false;
      els.alerts.innerHTML = a.messages.map(m => `• ${escapeHTML(m)}`).join("<br>");
    }
  }catch(_){ /* ignore */ }

  const index = await loadJSON(INDEX_URL);
  const posts = (index.posts || []).slice().sort((a,b)=>a.date.localeCompare(b.date));

  const postsByDate = new Map(posts.map(p => [p.date, p]));
  renderWeek(postsByDate, todayISO);
  renderHero(posts, todayISO);

  // Feed (scroll infini)
  const postsDesc = posts.slice().sort((a,b)=>b.date.localeCompare(a.date));
  let cursor = 0;

  function appendBatch(){
    const batch = postsDesc.slice(cursor, cursor + BATCH_SIZE);
    if (!batch.length) return;
    els.feed.insertAdjacentHTML("beforeend", batch.map(p => renderPostCard(p, todayISO)).join(""));
    cursor += batch.length;
  }

  appendBatch();

  const io = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) appendBatch();
  }, { rootMargin: "600px" });

  io.observe(els.sentinel);
}

main().catch(err => {
  els.alerts.hidden = false;
  els.alerts.innerHTML = `• Erreur dashboard: ${escapeHTML(err.message)}`;
});
