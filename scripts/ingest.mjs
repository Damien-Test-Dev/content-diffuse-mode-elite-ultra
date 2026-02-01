import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const INBOX_POSTS = path.join(ROOT, "inbox", "posts");
const INBOX_IMAGES = path.join(ROOT, "inbox", "images");
const MANIFEST = path.join(ROOT, "inbox", "manifest.csv");

const OUT_POSTS = path.join(ROOT, "content", "posts");
const OUT_IMAGES = path.join(ROOT, "content", "images");

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg"]); // simple & compatible

function parisISODate(d = new Date()){
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" }); // YYYY-MM-DD
}

function isWeekdayISO(iso){
  const dt = new Date(iso + "T12:00:00Z");
  const day = dt.getUTCDay(); // 0..6
  return day >= 1 && day <= 5;
}

function nextISO(iso){
  const dt = new Date(iso + "T12:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0,10);
}

async function ensureDirs(){
  for (const d of [INBOX_POSTS, INBOX_IMAGES, OUT_POSTS, OUT_IMAGES]){
    await fs.mkdir(d, { recursive: true });
  }
}

async function listFiles(dir){
  try{
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e=>e.isFile()).map(e=>e.name);
  }catch{
    return [];
  }
}

function parseISOFromName(name){
  const m = name.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

async function fileExists(p){
  try{ await fs.access(p); return true; } catch { return false; }
}

async function readManifest(){
  if (!(await fileExists(MANIFEST))) return null;
  const raw = await fs.readFile(MANIFEST, "utf8");
  const lines = raw.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);

  const pairs = [];
  for (const l of lines){
    if (l.startsWith("#")) continue;
    const [postName, imageName] = l.split(",").map(s=>s?.trim());
    if (postName && imageName) pairs.push({ postName, imageName });
  }
  return pairs.length ? pairs : null;
}

async function nextAvailableStartDate(){
  const today = parisISODate();

  const existing = (await listFiles(OUT_POSTS))
    .map(parseISOFromName)
    .filter(Boolean)
    .sort();

  let start = today;
  if (existing.length){
    start = nextISO(existing[existing.length - 1]);
    if (start < today) start = today;
  }

  // advance to weekday
  while (!isWeekdayISO(start)) start = nextISO(start);
  return start;
}

async function ingest(){
  await ensureDirs();

  const inboxPosts = (await listFiles(INBOX_POSTS)).sort();
  const inboxImages = (await listFiles(INBOX_IMAGES)).sort();

  if (!inboxPosts.length && !inboxImages.length){
    console.log("No inbox files. Nothing to ingest.");
    return;
  }

  if (inboxPosts.length !== inboxImages.length){
    throw new Error(`Inbox mismatch: ${inboxPosts.length} posts vs ${inboxImages.length} images`);
  }

  let pairs = await readManifest();
  if (!pairs){
    // fallback: pair by alphabetical order (best-effort)
    console.log("No manifest.csv → pairing by alphabetical order (best-effort).");
    pairs = inboxPosts.map((p,i)=>({ postName: p, imageName: inboxImages[i] }));
  }

  // basic validation
  for (const { postName, imageName } of pairs){
    const postPath = path.join(INBOX_POSTS, postName);
    const imgPath = path.join(INBOX_IMAGES, imageName);
    if (!(await fileExists(postPath))) throw new Error(`Missing post in inbox: ${postName}`);
    if (!(await fileExists(imgPath))) throw new Error(`Missing image in inbox: ${imageName}`);

    const ext = path.extname(imageName).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) throw new Error(`Unsupported image extension: ${imageName}`);
  }

  // allocate dates
  let cursor = await nextAvailableStartDate();

  for (const { postName, imageName } of pairs){
    // skip weekends
    while (!isWeekdayISO(cursor)) cursor = nextISO(cursor);

    const postSrc = path.join(INBOX_POSTS, postName);
    const imgSrc = path.join(INBOX_IMAGES, imageName);

    const imgExt = path.extname(imageName).toLowerCase();
    const postDst = path.join(OUT_POSTS, `${cursor}.txt`);
    const imgDst = path.join(OUT_IMAGES, `${cursor}${imgExt}`);

    await fs.rename(postSrc, postDst);
    await fs.rename(imgSrc, imgDst);

    console.log(`Ingested: ${postName} + ${imageName} → ${cursor}`);

    cursor = nextISO(cursor);
  }
}

ingest().catch(err => {
  console.error(err);
  process.exit(1);
});
