// Rolling Home check-in server (Cloudflare Worker)
//
// What it does:
//   - The app saves each person's check-in settings here (who to alert, what time).
//   - Each check-in from the app is recorded here.
//   - Every 15 minutes, a scheduled run looks for anyone who missed their check-in
//     and alerts their check-in person once: a text message (Twilio) and/or a
//     phone notification (ntfy).
//
// Bindings and secrets (set in the Cloudflare dashboard):
//   KV namespace binding:  RH            (stores settings and check-ins)
//   Secret INVITE_CODE      required: setup code people enter in the app before it will save settings
//   Secret TWILIO_SID       optional: Twilio Account SID (texts are skipped until all three Twilio values exist)
//   Secret TWILIO_TOKEN     optional: Twilio Auth Token
//   Secret TWILIO_FROM      optional: the Twilio phone number texts come from, like +16025550100
//   Variable APP_ORIGIN     optional: the app's web address, to only accept calls from it (e.g. https://susantemplin.github.io)
//   Cron trigger:           */15 * * * *

const GRACE_MIN = 30;          // minutes after the check-in time before an alert goes out
const WINDOW_H = 12;           // a check-in counts if it happened up to 12 hours before the check-in time
const MAX_BODY = 4000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = env.APP_ORIGIN ? (origin === env.APP_ORIGIN ? origin : env.APP_ORIGIN) : "*";
    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method !== "POST") return json({ ok: true, service: "Rolling Home check-in server" });

    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return json({ ok: false, error: "Request too large." }, 413);
      body = JSON.parse(text || "{}");
    } catch (e) { return json({ ok: false, error: "Bad request." }, 400); }

    const token = typeof body.token === "string" ? body.token : "";
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(token)) return json({ ok: false, error: "Missing device key." }, 400);
    const key = "user:" + token;

    if (url.pathname === "/api/settings") {
      if (!env.INVITE_CODE || body.invite !== env.INVITE_CODE) return json({ ok: false, error: "That setup code isn't right. Ask Mom for the code." }, 403);
      const s = cleanSettings(body);
      if (s.error) return json({ ok: false, error: s.error }, 400);
      const prev = await getUser(env, key);
      const user = { ...(prev || {}), ...s.value, updated: Date.now() };
      if (!user.created) user.created = Date.now();
      if (!user.loc) delete user.lastLoc;
      await env.RH.put(key, JSON.stringify(user));
      return json({ ok: true });
    }

    if (url.pathname === "/api/checkin") {
      const user = await getUser(env, key);
      if (!user) return json({ ok: false, error: "Set up your check-in person first." }, 404);
      user.lastCheckin = Date.now();
      user.alertedFor = null;
      if (typeof body.tz === "number" && Math.abs(body.tz) <= 900) user.tz = body.tz;
      if (user.loc && isCoord(body.lat, body.lng)) user.lastLoc = { lat: +body.lat.toFixed(5), lng: +body.lng.toFixed(5), at: Date.now() };
      else if (!user.loc) delete user.lastLoc;
      await env.RH.put(key, JSON.stringify(user));
      return json({ ok: true, lastCheckin: user.lastCheckin });
    }

    if (url.pathname === "/api/status") {
      const user = await getUser(env, key);
      if (!user) return json({ ok: true, registered: false });
      return json({ ok: true, registered: true, name: user.name, time: user.time, lastCheckin: user.lastCheckin || 0, texting: !!(user.phone && twilioReady(env)), notify: !!user.ntfy });
    }

    if (url.pathname === "/api/delete") {
      await env.RH.delete(key);
      return json({ ok: true });
    }

    if (url.pathname === "/api/test-alert") {
      const user = await getUser(env, key);
      if (!user) return json({ ok: false, error: "Set up your check-in person first." }, 404);
      const since = Date.now() - (user.lastTest || 0);
      if (since < 10 * 60 * 1000) return json({ ok: false, error: "You just sent a test. Try again in a few minutes." }, 429);
      user.lastTest = Date.now();
      await env.RH.put(key, JSON.stringify(user));
      const result = await sendAlert(env, user, "Rolling Home test: this is how you'll be alerted if " + (user.who || "your person") + " misses a check-in. No action needed.");
      return json({ ok: true, result });
    }

    return json({ ok: false, error: "Not found." }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env, Date.now()));
  }
};

async function getUser(env, key) {
  const raw = await env.RH.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function isCoord(lat, lng) {
  return typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function cleanSettings(b) {
  const name = String(b.name || "").trim().slice(0, 40);          // check-in person's name, e.g. "Mom"
  const who = String(b.who || "").trim().slice(0, 40);            // the person checking in, e.g. "Dustin"
  const phoneRaw = String(b.phone || "").trim();
  const digits = phoneRaw.replace(/\D/g, "");
  const time = String(b.time || "21:00");
  const ntfy = String(b.ntfy || "").trim();
  if (!name) return { error: "Add the name of your check-in person." };
  if (!who) return { error: "Add your own first name so the alert says who missed a check-in." };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: "Pick a check-in time." };
  let phone = "";
  if (digits) {
    if (digits.length === 10) phone = "+1" + digits;
    else if (digits.length === 11 && digits[0] === "1") phone = "+" + digits;
    else return { error: "Use a 10-digit US phone number." };
  }
  if (ntfy && !/^[A-Za-z0-9_-]{12,64}$/.test(ntfy)) return { error: "That notification code doesn't look right." };
  if (!phone && !ntfy) return { error: "Add a phone number or a notification code so alerts have somewhere to go." };
  const tz = typeof b.tz === "number" && Math.abs(b.tz) <= 900 ? b.tz : 420;
  return { value: { name, who, phone, time, ntfy, tz, loc: !!b.loc } };
}

// Most recent check-in time at or before `now`, as a timestamp. tz is minutes behind UTC (JS getTimezoneOffset).
function lastDue(now, time, tz) {
  const [h, m] = time.split(":").map(Number);
  const local = new Date(now - tz * 60000);
  let due = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) + tz * 60000;
  if (due > now) due -= 86400000;
  return due;
}

function needsAlert(user, now) {
  if (!user || !user.time) return false;
  const due = lastDue(now, user.time, typeof user.tz === "number" ? user.tz : 420);
  if (now < due + GRACE_MIN * 60000) return false;                 // still in the grace period
  if (user.alertedFor === due) return false;                       // already alerted for this one
  if ((user.created || 0) > due) return false;                     // set up after this check-in time
  const last = user.lastCheckin || 0;
  return last < due - WINDOW_H * 3600000;                          // no check-in in the window before the due time
}

async function runChecks(env, now) {
  let cursor, sent = 0;
  do {
    const page = await env.RH.list({ prefix: "user:", cursor });
    for (const k of page.keys) {
      const user = await getUser(env, k.name);
      if (!needsAlert(user, now)) continue;
      const due = lastDue(now, user.time, typeof user.tz === "number" ? user.tz : 420);
      user.alertedFor = due;
      await env.RH.put(k.name, JSON.stringify(user));              // mark first so a slow send never repeats
      await sendAlert(env, user, alertText(user, due, now));
      sent++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return sent;
}

function fmtTime(ts, tz) {
  const d = new Date(ts - tz * 60000);
  let h = d.getUTCHours(), m = d.getUTCMinutes();
  const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap;
}

function alertText(user, due, now) {
  const tz = typeof user.tz === "number" ? user.tz : 420;
  const who = user.who || "Your person";
  let t = "Rolling Home: " + who + " missed the " + fmtTime(due, tz) + " check-in.";
  if (user.lastCheckin) {
    const days = Math.floor((now - user.lastCheckin) / 86400000);
    t += " Last check-in: " + (days >= 1 ? days + (days === 1 ? " day" : " days") + " ago" : "today") + " at " + fmtTime(user.lastCheckin, tz) + ".";
  } else {
    t += " No check-ins yet.";
  }
  if (user.loc && user.lastLoc) t += " Last known spot: https://maps.google.com/?q=" + user.lastLoc.lat + "," + user.lastLoc.lng;
  t += " Try calling them.";
  return t;
}

function twilioReady(env) { return !!(env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM); }

async function sendAlert(env, user, text) {
  const result = { text: "skipped", notify: "skipped" };
  if (user.phone && twilioReady(env)) {
    try {
      const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + env.TWILIO_SID + "/Messages.json", {
        method: "POST",
        headers: { "Authorization": "Basic " + btoa(env.TWILIO_SID + ":" + env.TWILIO_TOKEN), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: user.phone, From: env.TWILIO_FROM, Body: text }).toString()
      });
      result.text = r.ok ? "sent" : "failed " + r.status;
    } catch (e) { result.text = "failed"; }
  }
  if (user.ntfy) {
    try {
      const r = await fetch("https://ntfy.sh/" + user.ntfy, {
        method: "POST",
        headers: { "Title": "Rolling Home check-in", "Priority": "high", "Tags": "rotating_light" },
        body: text
      });
      result.notify = r.ok ? "sent" : "failed " + r.status;
    } catch (e) { result.notify = "failed"; }
  }
  return result;
}
