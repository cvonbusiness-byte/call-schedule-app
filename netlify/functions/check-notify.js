// ฟังก์ชันนี้ต้องถูก "ปลุก" ทุก 1 นาทีโดยบริการ cron ภายนอก (เช่น cron-job.org)
// หน้าที่: เช็คว่ามีนัดไหนใกล้ถึงใน 5 นาทีข้างหน้าไหม ถ้ามีและยังไม่เคยแจ้ง -> ส่งข้อความเข้ากลุ่ม LINE
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  });
}
const db = admin.firestore();

exports.handler = async () => {
  try {
    const configDoc = await db.collection('callScheduleApp').doc('config').get();
    const groupId = configDoc.exists ? configDoc.data().groupId : null;
    if (!groupId) {
      return { statusCode: 200, body: 'ยังไม่มี Group ID (รอบอทถูกเชิญเข้ากลุ่มและมีคนพิมพ์ในกลุ่มก่อน)' };
    }

    const scheduleDoc = await db.collection('callScheduleApp').doc('call-schedule').get();
    if (!scheduleDoc.exists) {
      return { statusCode: 200, body: 'ยังไม่มีตารางนัด' };
    }
    const calls = JSON.parse(scheduleDoc.data().data || '[]');

    const now = new Date();
    const in5min = new Date(now.getTime() + 5 * 60000);
    let sentCount = 0;

    for (const c of calls) {
      const start = new Date(`${c.date}T${c.time}:00`);
      if (start > now && start <= in5min) {
        const notifiedRef = db.collection('callScheduleApp_notified').doc(c.id);
        const notifiedSnap = await notifiedRef.get();
        if (notifiedSnap.exists) continue;

        await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
          },
          body: JSON.stringify({
            to: groupId,
            messages: [{
              type: 'text',
              text: `⏰ อีก 5 นาทีจะเริ่มนัดคุยผ่าน ${c.platform} แล้วนะ!\n${c.date} เวลา ${c.time} น.${c.note ? '\n' + c.note : ''}`
            }]
          })
        });

        await notifiedRef.set({ notifiedAt: Date.now() });
        sentCount++;
      }
    }

    return { statusCode: 200, body: `checked, sent ${sentCount}` };
  } catch (err) {
    console.error('check-notify error', err);
    return { statusCode: 500, body: 'error: ' + err.message };
  }
};
