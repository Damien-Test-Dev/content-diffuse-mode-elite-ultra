import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const INBOX_POSTS  = path.join(ROOT, "inbox", "posts");
const INBOX_IMAGES = path.join(ROOT, "inbox", "images");

const CONTENT_POSTS  = path.join(ROOT, "content", "posts");
const CONTENT_IMAGES = path.join(ROOT, "content", "images");

const DOCS = path.join(ROOT, "docs");
const DOCS_IMAGES = path.join(DOCS, "assets", "images");
const DOCS_OUTBOX = path.join(DOCS, "outbox");

const MAX_PAIRS = 200;

const POST_EXTS  = new Set([".txt", ".md"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg"]);

function parisISODate(d = new Date()){
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" }); // YYYY-MM-DD
}
function isoToUTCNoon(iso){ return new Date(`${iso}T12:00:00Z`); }
function addDaysISO(iso, days){
  const dt = isoToUTCNoon(iso);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0,10);
}
function isWeekdayISO(iso){
  const dt = isoToUTCNoon(iso);
  const day = dt.getUTCDay();
  return day >= 1 && day <= 5;
}
function nextWeekdayISO(iso){
  let cur = iso;
  while (!isWeekdayISO(cur)) cur = addDaysISO(cur, 1);
  return cur;
}
function parseISOFromName(name){
  const m = name.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}
function compare(a,b){ return a < b ? -1 : a > b ? 1 : 0; }

async function ensureDirs(){
  for (const p of [INBOX_POSTS, INBOX_IMAGES, CONTENT_POSTS, CONTENT_IMAGES, DOCS, DOCS_IMAGES, DOCS_OUTBOX]){
    await fs.mkdir(p, { recursive: true });
  }
}

async function listFiles(dir){
  try{
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => e.name);
  }catch{
    return [];
  }
}

async function readText(p){ return fs.readFile(p, "utf8"); }

async function fileExists(p){
  try{ await fs.access(p); return true; } catch { return false; }
}

async function safeWriteJSON(p, obj){
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf8");
}

async function writeAlerts(messages){
  await safeWriteJSON(path.join(DOCS, "alerts.json"), {
    generated_at: new Date().toISOString(),
    messages
  });
}

async function renameInboxToContent(alerts){
  const inboxPostsAll  = (await listFiles(INBOX_POSTS)).filter(n => n !== ".gitkeep");
  const inboxImagesAll = (await listFiles(INBOX_IMAGES)).filter(n => n !== ".gitkeep");

  if (!inboxPostsAll.length && !inboxImagesAll.length) return;

  const inboxPosts = inboxPostsAll
    .filter(n => POST_EXTS.has(path.extname(n).toLowerCase()))
    .sort((a,b)=>a.localeCompare(b));

  const inboxImages = inboxImagesAll
    .filter(n => IMAGE_EXTS.has(path.extname(n).toLowerCase()))
    .sort((a,b)=>a.localeCompare(b));

  if (inboxPosts.length !== inboxPostsAll.length){
    alerts.push("Inbox posts: extensions non supportées (autorisé: .txt, .md).");
    return;
  }
  if (inboxImages.length !== inboxImagesAll.length){
    alerts.push("Inbox images: extensions non supportées (autorisé: .png, .jpg, .jpeg).");
    return;
  }

  const pairsToCreate = Math.min(inboxPosts.length, inboxImages.length);
  if (pairsToCreate === 0){
    if (inboxPosts.length > 0) alerts.push(`En attente d'images: ${inboxPosts.length} post(s) en inbox.`);
    if (inboxImages.length > 0) alerts.push(`En attente de posts: ${inboxImages.length} image(s) en inbox.`);
    return;
  }

  // Start at tomorrow (Paris), weekday, and after last scheduled if needed
  const today = parisISODate();
  const tomorrow = addDaysISO(today, 1);
  let cursor = nextWeekdayISO(tomorrow);

  const existingDates = (await listFiles(CONTENT_POSTS))
    .map(parseISOFromName)
    .filter(Boolean)
    .sort();

  if (existingDates.length){
    const last = existingDates[existingDates.length - 1];
    let afterLast = nextWeekdayISO(addDaysISO(last, 1));
    if (compare(afterLast, cursor) > 0) cursor = afterLast;
  }

  const used = new Set(existingDates);

  alerts.push(`Mode sans manifest: slots (1 post + 1 image) à partir de ${cursor} (lun→ven).`);
  alerts.push("Association post/image: tri alphabétique dans chaque inbox (stable).");

  let created = 0;
  for (let i=0; i<pairsToCreate; i++){
    while (used.has(cursor) || !isWeekdayISO(cursor)){
      cursor = nextWeekdayISO(addDaysISO(cursor, 1));
    }

    const postName = inboxPosts[i];
    const imgName  = inboxImages[i];

    const postSrc = path.join(INBOX_POSTS, postName);
    const imgSrc  = path.join(INBOX_IMAGES, imgName);

    const imgExt = path.extname(imgName).toLowerCase();

    const postDst = path.join(CONTENT_POSTS, `${cursor}.txt`);
    const imgDst  = path.join(CONTENT_IMAGES, `${cursor}${imgExt}`);

    await fs.rename(postSrc, postDst);
    await fs.rename(imgSrc, imgDst);

    used.add(cursor);
    created++;
    cursor = nextWeekdayISO(addDaysISO(cursor, 1));
  }

  const remainingPosts = inboxPosts.length - created;
  const remainingImgs  = inboxImages.length - created;

  alerts.push(`Slots créés: ${created}. Reste en inbox → posts: ${remainingPosts}, images: ${remainingImgs}.`);
}

async function pruneTo200(alerts){
  const posts = (await listFiles(CONTENT_POSTS))
    .filter(n => n.endsWith(".txt"))
    .map(n => ({ name:n, date: parseISOFromName(n) }))
    .filter(x => x.date)
    .sort((a,b)=>a.date.localeCompare(b.date));

  if (posts.length <= MAX_PAIRS) return;

  const toDelete = posts.slice(0, posts.length - MAX_PAIRS);
  for (const p of toDelete){
    await fs.rm(path.join(CONTENT_POSTS, p.name), { force: true });

    const imgs = (await listFiles(CONTENT_IMAGES)).filter(n => n.startsWith(p.date + "."));
    for (const img of imgs){
      await fs.rm(path.join(CONTENT_IMAGES, img), { force: true });
    }
  }
  alerts.push(`Purge: suppression de ${toDelete.length} slot(s) pour rester à ${MAX_PAIRS}.`);
}

async function copyImagesToDocs(){
  await fs.mkdir(DOCS_IMAGES, { recursive: true });

  const existing = (await listFiles(DOCS_IMAGES)).filter(n => n !== ".gitkeep");
  await Promise.all(existing.map(n => fs.rm(path.join(DOCS_IMAGES, n), { force: true })));

  const imgs = (await listFiles(CONTENT_IMAGES)).filter(n => n !== ".gitkeep");
  for (const img of imgs){
    await fs.copyFile(path.join(CONTENT_IMAGES, img), path.join(DOCS_IMAGES, img));
  }
}

async function buildIndexAndOutbox(alerts){
  const postFiles = (await listFiles(CONTENT_POSTS))
    .filter(n => n.endsWith(".txt"))
    .map(n => ({ name:n, date: parseISOFromName(n) }))
    .filter(x => x.date)
    .sort((a,b)=>a.date.localeCompare(b.date));

  const imageFiles = (await listFiles(CONTENT_IMAGES)).filter(n => n !== ".gitkeep");

  const posts = [];
  for (const p of postFiles){
    const img = imageFiles.find(n => n.startsWith(p.date + "."));
    if (!img){
      alerts.push(`Anomalie: image manquante pour ${p.date} (content/images).`);
      continue;
    }
    const text = await readText(path.join(CONTENT_POSTS, p.name));
    posts.push({
      date: p.date,
      text,
      image_file: img,
      image_url: `./assets/images/${img}`
    });
  }

  await safeWriteJSON(path.join(DOCS, "index.json"), {
    generated_at: new Date().toISOString(),
    count: posts.length,
    posts
  });

  const today = parisISODate();
  const todayPost = posts.find(p => p.date === today);
  const todayPath = path.join(DOCS_OUTBOX, "today.json");

  if (todayPost){
    await safeWriteJSON(todayPath, todayPost);
  } else if (await fileExists(todayPath)){
    await fs.rm(todayPath, { force: true });
  }
}

async function main(){
  const alerts = [];
  await ensureDirs();

  await renameInboxToContent(alerts);
  await pruneTo200(alerts);
  await copyImagesToDocs();
  await buildIndexAndOutbox(alerts);

  await writeAlerts(alerts);
}

main().catch(async (err) => {
  await writeAlerts([`Pipeline error: ${err?.message || String(err)}`]);
  process.exit(0);
});
