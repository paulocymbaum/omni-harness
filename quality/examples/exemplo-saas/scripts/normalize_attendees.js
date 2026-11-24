// Node script para normalizar attendees legados
// Uso: node scripts/normalize_attendees.js

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

async function run() {
  const eventsSnap = await db.collection('events').get();
  let updated = 0;
  for (const ev of eventsSnap.docs) {
    const attSnap = await ev.ref.collection('attendees').get();
    for (const att of attSnap.docs) {
      const data = att.data() || {};
      const uid = data.uid || att.id;
      let status = data.status || 'interested';
      if (status !== 'going' && status !== 'interested') {
        status = 'interested';
      }
      await att.ref.set({ uid, status }, { merge: true });
      updated++;
    }
  }
  console.log(`Normalização concluída. Docs atualizados: ${updated}`);
}

run().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
