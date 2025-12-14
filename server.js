// server.js
// Node.js + ws. Serves static files + WebSocket game sync.
// Run: npm i ws && node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";
const QUESTIONS_PATH = process.env.QUESTIONS_PATH || path.join(__dirname, "questions.json");

const TEAMS = ["A","B","C"];

let questions = [];
function loadQuestions(){
  const raw = fs.readFileSync(QUESTIONS_PATH, "utf8");
  const data = JSON.parse(raw);
  if(!Array.isArray(data)) throw new Error("questions.json must be an array");
  // minimal validation + normalization
  questions = data.map(q => ({
    id: q.id,
    type: q.type || "text",
    difficulty: q.difficulty || "medium",
    title: q.title || `חידה ${q.id}`,
    prompt: q.prompt || "",
    media: q.media || null,
    hint: q.hint || "",
    acceptedAnswers: Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : [],
    points: (q.points != null) ? q.points : undefined
  })).sort((a,b)=>a.id-b.id);
}
loadQuestions();

// Game state
let state = {
  status: "waiting",        // waiting | running | ended
  startTs: null,            // ms
  durationSec: 20*60,
  teamsLocked: false,
  questionsSent: false
};

// Team answers store: team -> qid -> { solved:boolean, bestAnswer:string, solverName:string, hintUsed:boolean }
let teamProgress = {
  A: new Map(),
  B: new Map(),
  C: new Map()
};

// Connections: ws -> session
// session: {name, team, mode, isAdmin}
const sessions = new Map();

function normalizeAnswer(s){
  if(!s) return "";
  s = String(s).trim().toLowerCase();
  s = s.replace(/[\u0591-\u05C7]/g, ""); // Hebrew diacritics
  s = s.replace(/[\"'`~!@#$%^&*()_\-+=\[\]{}\\|;:,.<>/?״׳]/g, "");
  s = s.replace(/\s+/g, "");
  if(s.startsWith("ו") && s.length>1) s = s.slice(1);
  return s;
}

function computeQuestionPoints(q){
  if(q.points != null) return q.points;
  if(q.difficulty==="easy") return 1;
  if(q.difficulty==="hard") return 3;
  return 2;
}

function checkCorrect(q, ans){
  const a = normalizeAnswer(ans);
  if(!a) return false;
  for(const acc of (q.acceptedAnswers||[])){
    if(normalizeAnswer(acc) === a) return true;
  }
  return false;
}

function teamScores(){
  const out = {};
  for(const t of TEAMS){
    let pts = 0, solved = 0;
    for(const q of questions){
      const rec = teamProgress[t].get(q.id);
      if(rec && rec.solved){
        let p = computeQuestionPoints(q);
        if(rec.hintUsed) p = Math.max(0, p - 1); // hint penalty
        pts += p;
        solved++;
      }
    }
    out[t] = {points: pts, solved};
  }
  return out;
}

function teamOnlineCounts(){
  const c = {A:0,B:0,C:0};
  for(const s of sessions.values()){
    if(s.mode==="player" || s.mode==="admin"){
      if(c[s.team] != null) c[s.team]++;
    }
  }
  return c;
}

function roster(){
  const r = [];
  for(const s of sessions.values()){
    r.push({name:s.name, team:s.team, mode:s.mode});
  }
  return r;
}

function broadcast(type, payload){
  const msg = JSON.stringify({type, payload});
  for(const ws of sessions.keys()){
    if(ws.readyState === WebSocket.OPEN){
      ws.send(msg);
    }
  }
}

function send(ws, type, payload){
  if(ws.readyState === WebSocket.OPEN){
    ws.send(JSON.stringify({type, payload}));
  }
}

function uniqueName(team, name){
  // prevent duplicate same name in same team
  const base = name.trim();
  let candidate = base;
  let i = 2;
  const used = new Set();
  for(const s of sessions.values()){
    if(s.team===team) used.add(s.name);
  }
  while(used.has(candidate)){
    candidate = `${base} ${i}`;
    i++;
  }
  return candidate;
}

function resetTeamProgress(){
  for(const t of TEAMS) teamProgress[t] = new Map();
}

function validateAdmin(payload){
  return payload && payload.adminKey && payload.adminKey === ADMIN_KEY;
}

// Static server (index.html + questions.json)
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if(urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(__dirname, urlPath);
  if(!filePath.startsWith(__dirname)){
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if(err){
      res.writeHead(404); return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = ({
      ".html":"text/html; charset=utf-8",
      ".js":"application/javascript; charset=utf-8",
      ".json":"application/json; charset=utf-8",
      ".css":"text/css; charset=utf-8",
      ".png":"image/png",
      ".jpg":"image/jpeg",
      ".jpeg":"image/jpeg",
      ".svg":"image/svg+xml",
      ".mp4":"video/mp4"
    })[ext] || "application/octet-stream";
    res.writeHead(200, {"Content-Type": ct});
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.on("message", (buf) => {
    let msg;
    try{ msg = JSON.parse(buf.toString("utf8")); }catch(e){ return; }
    const {type, payload} = msg || {};
    if(type==="hello"){
      const mode = (payload?.mode || "player").toLowerCase();
      let name = String(payload?.name || "").trim();
      let team = String(payload?.team || "A").toUpperCase();
      if(!TEAMS.includes(team)) team = "A";

      let isAdmin = false;
      if(mode==="admin"){
        isAdmin = (String(payload?.adminKey || "") === ADMIN_KEY);
        if(!isAdmin){
          send(ws, "error", {message:"מפתח מנהל שגוי."});
          // still allow as player to avoid dead end:
          // user can reconnect with correct key
        }
      }

      if(mode==="screen"){
        name = "SCREEN";
        team = "A";
      } else {
        if(name.length < 2){
          // require a name for players/admin
          name = "אורח";
        }
        name = uniqueName(team, name);
      }

      const session = {name, team, mode, isAdmin};
      sessions.set(ws, session);

      // welcome: include questions only if already running
      const welcomePayload = {
        me: {name, team, mode, isAdmin},
        state,
        roster: roster(),
        teamScores: teamScores(),
        teamOnline: teamOnlineCounts()
      };
      if(state.status==="running"){
        welcomePayload.questions = questions;
      }
      send(ws, "welcome", welcomePayload);

      broadcast("roster", {roster: roster(), teamOnline: teamOnlineCounts()});
      return;
    }

    const session = sessions.get(ws);
    if(!session){
      send(ws, "error", {message:"לא מזוהה. רענן דף."});
      return;
    }

    if(type==="submitAnswers"){
      if(state.status!=="running"){
        return;
      }
      if(session.mode==="screen") return;

      const ans = payload?.answers || {};
      const t = session.team;

      for(const q of questions){
        const v = ans[q.id];
        if(typeof v !== "string") continue;
        const correct = checkCorrect(q, v);
        if(correct){
          const rec = teamProgress[t].get(q.id) || {solved:false, bestAnswer:"", solverName:"", hintUsed:false};
          // once solved, keep first solver by default
          if(!rec.solved){
            rec.solved = true;
            rec.bestAnswer = v;
            rec.solverName = session.name;
          } else {
            // already solved: keep earlier, do nothing
          }
          teamProgress[t].set(q.id, rec);
        }
        // ack only for this user (client will paint green)
        send(ws, "answerAck", {qid: q.id, correct});
      }

      broadcast("scores", {teamScores: teamScores()});
      return;
    }

    if(type==="hintUsed"){
      if(state.status!=="running") return;
      if(session.mode==="screen") return;
      const qid = payload?.qid;
      if(typeof qid !== "number") return;
      const t = session.team;
      const rec = teamProgress[t].get(qid) || {solved:false, bestAnswer:"", solverName:"", hintUsed:false};
      rec.hintUsed = true;
      teamProgress[t].set(qid, rec);
      broadcast("scores", {teamScores: teamScores()});
      return;
    }

    if(type==="syncMyLocal"){
      // do not override correctness; just accept a correct if any
      if(state.status!=="running") return;
      if(session.mode==="screen") return;
      const ans = payload?.answers || {};
      const hints = payload?.hints || {};
      const t = session.team;

      for(const q of questions){
        const v = ans[q.id];
        if(typeof v === "string"){
          const correct = checkCorrect(q, v);
          if(correct){
            const rec = teamProgress[t].get(q.id) || {solved:false, bestAnswer:"", solverName:"", hintUsed:false};
            if(!rec.solved){
              rec.solved = true;
              rec.bestAnswer = v;
              rec.solverName = session.name;
            }
            teamProgress[t].set(q.id, rec);
          }
        }
        if(hints[q.id]){
          const rec = teamProgress[t].get(q.id) || {solved:false, bestAnswer:"", solverName:"", hintUsed:false};
          rec.hintUsed = true;
          teamProgress[t].set(q.id, rec);
        }
      }
      broadcast("scores", {teamScores: teamScores()});
      return;
    }

    // Admin commands
    if(type==="adminStart"){
      if(!validateAdmin(payload)){
        send(ws,"error",{message:"אין הרשאת מנהל."}); return;
      }
      const durationSec = Math.max(60, Number(payload?.durationSec || 20*60));
      state.status = "running";
      state.durationSec = durationSec;
      state.startTs = Date.now();
      state.questionsSent = true;

      // start auto-end timer
      scheduleAutoEnd();

      broadcast("state", {state, questions, teamScores: teamScores(), teamOnline: teamOnlineCounts()});
      return;
    }

    if(type==="adminEnd"){
      if(!validateAdmin(payload)){
        send(ws,"error",{message:"אין הרשאת מנהל."}); return;
      }
      endGame();
      return;
    }

    if(type==="adminReset"){
      if(!validateAdmin(payload)){
        send(ws,"error",{message:"אין הרשאת מנהל."}); return;
      }
      resetTeamProgress();
      broadcast("reset", {});
      broadcast("scores", {teamScores: teamScores()});
      return;
    }

    if(type==="adminReloadQuestions"){
      if(!validateAdmin(payload)){
        send(ws,"error",{message:"אין הרשאת מנהל."}); return;
      }
      try{
        loadQuestions();
        // if running: broadcast fresh questions (same IDs expected)
        broadcast("state", {state, questions, teamScores: teamScores(), teamOnline: teamOnlineCounts()});
      }catch(e){
        send(ws,"error",{message:"טעינת חידות נכשלה: " + e.message});
      }
      return;
    }

    if(type==="adminLockTeams"){
      if(!validateAdmin(payload)){
        send(ws,"error",{message:"אין הרשאת מנהל."}); return;
      }
      state.teamsLocked = true;
      broadcast("state", {state, teamScores: teamScores(), teamOnline: teamOnlineCounts()});
      return;
    }
  });

  ws.on("close", () => {
    sessions.delete(ws);
    broadcast("roster", {roster: roster(), teamOnline: teamOnlineCounts()});
  });
});

// auto end
let autoEndTimer = null;
function scheduleAutoEnd(){
  if(autoEndTimer) clearTimeout(autoEndTimer);
  if(state.status!=="running" || !state.startTs) return;
  const ms = state.durationSec * 1000;
  autoEndTimer = setTimeout(() => {
    endGame();
  }, ms + 50);
}
function endGame(){
  state.status = "ended";
  state.questionsSent = true;
  broadcast("state", {state, teamScores: teamScores(), teamOnline: teamOnlineCounts()});
}

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`ADMIN_KEY=${ADMIN_KEY}`);
  console.log(`Questions: ${QUESTIONS_PATH} (${questions.length} loaded)`);
});
