// One-time script to seed Firestore with existing JSON data
require('dotenv').config();
const { db } = require('./lib/firebase');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');

const arrayCollections = [
  { file: 'users.json', collection: 'users' },
];

const singleDocCollections = [];

async function seed() {
  console.log('\n  Seeding Firestore...\n');

  for (const { file, collection } of arrayCollections) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      const batch = db.batch();
      const arr = Array.isArray(data) ? data : [data];
      arr.forEach((doc, i) => {
        const id = doc.id ? String(doc.id) : String(i);
        batch.set(db.collection(collection).doc(id), doc);
      });
      await batch.commit();
      console.log(`  OK ${collection}: ${arr.length} documents`);
    } catch (err) {
      console.error(`  FAIL ${collection}: ${err.message}`);
    }
  }

  for (const { file, collection, docId } of singleDocCollections) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      await db.collection(collection).doc(docId).set(data);
      console.log(`  OK ${collection}/${docId}: seeded`);
    } catch (err) {
      console.error(`  FAIL ${collection}/${docId}: ${err.message}`);
    }
  }

  console.log('\n  Seeding complete!\n');
  process.exit(0);
}

seed();
