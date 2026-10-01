// หน้าเว็บเรียกฟังก์ชันนี้ทุกครั้งที่แอดมินบันทึกนัด -> ส่งข้อความเข้าทุกกลุ่ม LINE
// ฟังก์ชันอ่านนัดจาก Firestore เอง (ไม่เชื่อข้อมูลที่ส่งมา) และแจ้งแต่ละเวอร์ชันของนัดแค่ครั้งเดียว
// กันคนภายนอกยิงมาสแปมกลุ่ม
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  });
}
const db = admin.firestore();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function thaiDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]} ${d} ${MONTHS[m - 1]}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'POST only' };

  try {
    const { id } = JSON.parse(event.body || '{}');
    if (!id) return { statusCode: 400, headers: CORS, body: 'missing id' };

    const configDoc = await db.collection('callScheduleApp').doc('config').get();
    const cfg = configDoc.exists ? configDoc.data() : {};
    const groupIds = [...new Set([...(cfg.groupIds || []), ...(cfg.groupId ? [cfg.groupId] : [])])];
    if (groupIds.length === 0) return { statusCode: 200, headers: CORS, body: 'no groups' };

    const scheduleDoc = await db.collection('callScheduleApp').doc('call-schedule').get();
    if (!scheduleDoc.exists) return { statusCode: 200, headers: CORS, body: 'no schedule' };
    const calls = JSON.parse(scheduleDoc.data().data || '[]');
    const c = calls.find(x => x.id === id);
    if (!c) return { statusCode: 200, headers: CORS, body: 'call not found' };

    // แจ้งแต่ละเวอร์ชันของนัดครั้งเดียว (เวอร์ชัน = วัน/เวลา/แอป)
    const versionKey = [c.date, c.time, c.timeEnd || '', c.platform].join('|');
    const ref = db.collection('callScheduleApp_created').doc(id);
    const snap = await ref.get();
    if (snap.exists && snap.data().versionKey === versionKey) {
      return { statusCode: 200, headers: CORS, body: 'already notified' };
    }
    const isEdit = snap.exists;

    const time = c.timeEnd ? `${c.time}–${c.timeEnd}` : c.time;
    const text =
      `${isEdit ? '✏️ แก้ไขนัด' : '📅 มีนัดใหม่'}\n` +
      `${c.platform}\n` +
      `${thaiDate(c.date)} เวลา ${time} น.` +
      (c.note ? `\n${c.note}` : '') +
      (c.link ? `\n${c.link}` : '');

    let ok = 0;
    const errors = [];
    for (const gid of groupIds) {
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({ to: gid, messages: [{ type: 'text', text }] })
      });
      if (res.ok) ok++;
      else errors.push(`${gid.slice(0, 8)}...: ${res.status} ${await res.text()}`);
    }

    if (ok > 0) await ref.set({ versionKey, notifiedAt: Date.now() });

    return {
      statusCode: ok > 0 ? 200 : 500,
      headers: CORS,
      body: `sent to ${ok}/${groupIds.length} groups${errors.length ? ' | ' + errors.join(' ; ') : ''}`
    };
  } catch (err) {
    console.error('notify-new error', err);
    return { statusCode: 500, headers: CORS, body: 'error: ' + err.message };
  }
};
