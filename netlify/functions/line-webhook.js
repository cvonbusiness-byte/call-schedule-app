// รับ event จาก LINE ตอนบอทถูกเชิญเข้ากลุ่ม / มีคนพิมพ์ในกลุ่ม
// หน้าที่เดียวคือ "จำ Group ID" เก็บไว้ใน Firestore เพื่อให้ check-notify.js เอาไปใช้ยิงข้อความ
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  });
}
const db = admin.firestore();

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const lineEvents = body.events || [];

    for (const e of lineEvents) {
      if (e.source && e.source.type === 'group' && e.source.groupId) {
        await db.collection('callScheduleApp').doc('config').set(
          { groupId: e.source.groupId, updatedAt: Date.now() },
          { merge: true }
        );
        console.log('Saved group ID:', e.source.groupId);
      }
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('webhook error', err);
    return { statusCode: 200, body: 'OK' };
  }
};
