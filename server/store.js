// ─── Data store ──────────────────────────────────────────────
// Firestore when FIREBASE_* variables are set, otherwise data/users.json
// (local development). All reads and writes go through this module so the
// routes never care which backend is active.

const fs = require('fs');
const path = require('path');
const config = require('./config');

let db = null;
if (process.env.FIREBASE_PROJECT_ID) {
  try {
    db = require('../lib/firebase').db;
    console.log('[store] Firestore connected');
  } catch (err) {
    console.warn('[store] Firestore unavailable, using JSON files:', err.message);
  }
} else {
  console.log('[store] FIREBASE_PROJECT_ID not set, using JSON files in data/');
}

// ─── Users ───────────────────────────────────────────────────
const usersFile = () => config.usersFile || path.join(config.dataDir, 'users.json');
let usersCache = null; // JSON mode only: keeps users if the disk is read-only (Vercel)

function loadJsonUsers() {
  if (!usersCache) usersCache = JSON.parse(fs.readFileSync(usersFile(), 'utf8'));
  return usersCache;
}

function saveJsonUsers(users) {
  usersCache = users;
  try {
    fs.writeFileSync(usersFile(), JSON.stringify(users, null, 2));
  } catch (err) {
    console.warn('[store] Could not write users.json (read-only disk?). New users live in memory until restart. Configure Firestore for persistence.', err.message);
  }
}

async function listUsers() {
  if (db) {
    const snap = await db.collection('users').get();
    return snap.docs.map(d => ({ ...d.data(), id: d.data().id ?? d.id }));
  }
  return loadJsonUsers();
}

const lower = s => String(s || '').toLowerCase();

async function findUserByLogin(login) {
  const l = lower(login);
  return (await listUsers()).find(u => lower(u.username) === l || lower(u.email) === l) || null;
}

async function findUserByEmail(email) {
  const l = lower(email);
  if (db) {
    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!snap.empty) return snap.docs[0].data();
  }
  return (await listUsers()).find(u => lower(u.email) === l) || null;
}

async function findUserById(id) {
  return (await listUsers()).find(u => String(u.id) === String(id)) || null;
}

// Time-based ids cannot collide the way "max id + 1" does when two
// people sign up at once on different serverless instances.
function newUserId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

async function createUser(fields) {
  const user = { id: newUserId(), registeredAt: new Date().toISOString(), ...fields };
  if (db) {
    await db.collection('users').doc(String(user.id)).set(user);
  } else {
    const users = loadJsonUsers().slice();
    users.push(user);
    saveJsonUsers(users);
  }
  return user;
}

async function updateUser(id, changes) {
  if (db) {
    await db.collection('users').doc(String(id)).set(changes, { merge: true });
    return;
  }
  const users = loadJsonUsers().map(u => String(u.id) === String(id) ? { ...u, ...changes } : u);
  saveJsonUsers(users);
}

// ─── Reports & activity (Firestore, or memory for local dev) ─
const memory = { reports: [], activity: [] };

async function addReport(report) {
  if (db) {
    const ref = await db.collection('reports').add(report);
    return { id: ref.id, persistent: true };
  }
  const id = 'local-' + Date.now();
  memory.reports.push({ id, ...report });
  return { id, persistent: false };
}

async function listReports(userId) {
  if (db) {
    const snap = await db.collection('reports').where('userId', '==', userId).limit(50).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
  return memory.reports.filter(r => r.userId === userId).reverse();
}

async function logActivity(entry) {
  if (db) return db.collection('activity_logs').add(entry);
  memory.activity.push(entry);
  if (memory.activity.length > 500) memory.activity.shift();
}

async function listActivity(limit = 100) {
  if (db) {
    const snap = await db.collection('activity_logs').orderBy('timestamp', 'desc').limit(limit).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  return memory.activity.slice(-limit).reverse();
}

module.exports = {
  backend: () => (db ? 'firestore' : 'json'),
  listUsers, findUserByLogin, findUserByEmail, findUserById, createUser, updateUser,
  addReport, listReports, logActivity, listActivity
};
