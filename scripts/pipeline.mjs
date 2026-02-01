import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CONTENT_POSTS = path.join(ROOT, "content", "posts");
const CONTENT_IMAGES = path.join(ROOT, "content", "images");
const INBOX_POSTS = path.join(ROOT, "inbox", "posts");
const INBOX_IMAGES = path.join(ROOT, "inbox", "images");
const INBOX_MANIFEST = path.join(ROOT, "inbox", "manifest.csv");
const DOCS = path.join(ROOT, "docs");
const DOCS_IMAGES = path.join(DOCS, "assets", "images");

const MAX_POSTS = 200;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png"]);

function parisISODate(d = new Date()){
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
}

function parseISOFromName(name){
  const m = name.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function isWeekdayISO(iso){
  const dt = new Date(iso + "T12:00:00Z");
  const day = dt.getUTCDay();
  return day >= 1 && day <= 5;
}

function nextWeekdayISO(startISO){
  let d = new Date(startISO + "T12:00:00Z");
  while (true){
    const iso = d.toISOString().slice(0,10);
    if (isWeekdayISO(iso)) return iso;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

async function ensureDirs(){
  for (const p of [CONTENT_POSTS, CONTENT_IMAGES, INBOX_POSTS, INBOX_IMAGES, DOCS, DOCS_IMAGES]){
    await fs.mkdir(p, { recursive: true });
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

async function readText(filePath){
  return fs.readFile(filePath, "utf8");
}

async function fileExists(p){
  try{ await fs.access(p); return true; } catch { return false; }
}

async function parseManifest(){
  if (!(await fileExists(INBOX_MANIFEST))) return null;
  const raw = await readText(INBOX_MANIFEST);
  const lines = raw.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  // format: post_filename,image_filename
  const pairs = [];
  for (const l of lines){
    if (l.startsWith("#")) continue;
    const [postName, imageName] = l.split(",").map(s=>s?.trim());
    if (postName && imageName) pairs.push({ postName, imageName });
  }
  return pairs.length ? pairs : null;
}

async function organizeInbox(alerts){
  const postNames = (await listFiles(INBOX_POSTS)).sort();
  const imgNames = (await listFiles(INBOX_IMAGES)).sort();

  if (!postNames.length && !imgNames.length) return;

  if (postNames.length !== imgNames.length){
    alerts.push(`Inbox mismatch: ${postNames.length} posts vs ${imgNames.length} images. Upload the missing files (or use manifest.csv).`);
    return;
  }

  let pairs = await parseManifest();

  if (!pairs){
    // Best-effort pairing by alphabetical order
    alerts.push("Mode best-effort: pairing inbox by alphabetical order (no manifest.csv).");
    pairs = postNames.map((p,i)=>({ postName:p, imageName: imgNames[i] }));
  } else {
    // Validate manifest counts
    if (pairs.length !== postNames.length){
      alerts.push(`manifest.csv pairs=${pairs.length} but inbox posts=${postNames.length}. Fix manifest or inbox.`);
      return;
    }
  }

  // Determine start date = max(todayParis, latest existing + 1 day)
  const today = parisISODate();
  const existing = (await listFiles(CONTENT_POSTS))
    .map(parseISOFromName)
    .filter(Boolean)
    .sort();
  let start = today;
  if (existing.length){
    const last = existing[existing.length - 1];
    const d = new Date(last + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    start = d.toISOString().slice(0,10);
  }
  start = (start < today) ? today : start;
  start = nextWeekdayISO(start);

  // Avoid collisions if some dates already exist
  const used = new Set(existing);

  let cursorISO = start;
  for (const pair of pairs){
    // find next free weekday
    while (used.has(cursorISO) || !isWeekdayISO(cursorISO)){
      const d = new Date(cursorISO + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + 1);
      cursorISO = nextWeekdayISO(d.toISOString().slice(0,10));
    }

    const postSrc = path.join(INBOX_POSTS, pair.postName);
    const imgSrc  = path.join(INBOX_IMAGES, pair.imageName);
    const imgExt = path.extname(pair.imageName).toLowerCase();

    if (!IMAGE_EXTS.has(imgExt)){
      alerts.push(`Unsupported image extension for ${pair.imageName}. Use JPG/JPEG/PNG.`);
      return;
    }

    const postDst = path.join(CONTENT_POSTS, `${cursorISO}.txt`);
    const imgDst  = path.join(CONTENT_IMAGES, `${cursorISO}${imgExt}`);

    await fs.rename(postSrc, postDst);
    await fs.rename(imgSrc, imgDst);

    used.add(cursorISO);

    // next day
    const d = new Date(cursorISO + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    cursorISO = nextWeekdayISO(d.toISOString().slice(0,10));
  }
}

async function pruneTo200(alerts){
  const posts = (await listFiles(CONTENT_POSTS))
    .filter(n=>n.endsWith(".txt"))
    .map(n=>({ name:n, date: parseISOFromName(n) }))
    .filter(x=>x.date)
    .sort((a,b)=>a.date.localeCompare(b.date));

  if (posts.length <= MAX_POSTS) return;

  const toDelete = posts.slice(0, posts.length - MAX_POSTS);
  for (const p of toDelete){
    await fs.rm(path.join(CONTENT_POSTS, p.name), { force: true });

    // delete matching image (any ext)
    const imgs = (await listFiles(CONTENT_IMAGES)).filter(n=>n.startsWith(p.date + "."));
    for (const img of imgs){
      await fs.rm(path.join(CONTENT_IMAGES, img), { force: true });
    }
  }
  alerts.push(`Pruned ${toDelete.length} old posts to keep the last ${MAX_POSTS}.`);
}

async function copyImagesToDocs(){
  await fs.mkdir(DOCS_IMAGES, { recursive: true });
  // clean old
  const existing = await listFiles(DOCS_IMAGES);
  await Promise.all(existing.map(n=>fs.rm(path.join(DOCS_IMAGES,n), { force:true })));

  const imgs = await listFiles(CONTENT_IMAGES);
  for (const img of imgs){
    await fs.copyFile(path.join(CONTENT_IMAGES, img), path.join(DOCS_IMAGES, img));
  }
}

async function buildIndex(alerts){
  const posts = (await listFiles(CONTENT_POSTS))
    .filter(n=>n.endsWith(".txt"))
    .map(n=>({ name:n, date: parseISOFromName(n) }))
    .filter(x=>x.date)
    .sort((a,b)=>a.date.localeCompare(b.date));

  const images = await listFiles(CONTENT_IMAGES);

  const out = [];
  for (const p of posts){
    const text = await readText(path.join(CONTENT_POSTS, p.name));
    const img = images.find(n=>n.startsWith(p.date + "."));
    if (!img){
      alerts.push(`Missing image for ${p.date}.`);
      continue;
    }
    out.push({
      date: p.date,
      text,
      image_file: img,
      image_url: `./assets/images/${img}`
    });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    count: out.length,
    posts: out
  };

  await fs.writeFile(path.join(DOCS, "index.json"), JSON.stringify(payload, null, 2), "utf8");

  // Outbox “today” (utile pour Zapier ensuite)
  const today = parisISODate();
  const todayPost = out.find(x=>x.date === today);
  if (todayPost){
    await fs.mkdir(path.join(DOCS, "outbox"), { recursive: true });
    await fs.writeFile(path.join(DOCS, "outbox", "today.json"), JSON.stringify(todayPost, null, 2), "utf8");
  }
}

async function writeAlerts(alerts){
  const payload = { generated_at: new Date().toISOString(), messages: alerts };
  await fs.writeFile(path.join(DOCS, "alerts.json"), JSON.stringify(payload, null, 2), "utf8");
}

async function main(){
  const alerts = [];
  await ensureDirs();
  await organizeInbox(alerts);
  await pruneTo200(alerts);
  await copyImagesToDocs();
  await buildIndex(alerts);
  await writeAlerts(alerts);
}

main().catch(err=>{
  console.error(err);
  process.exit(1);
});
