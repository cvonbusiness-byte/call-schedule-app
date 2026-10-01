// ถูกเรียกทุก 1 นาทีโดย cron-job.org ทำ 2 อย่าง
// 1) นัดใหม่ / นัดที่ถูกแก้ -> แจ้งเข้าทุกกลุ่ม LINE
// 2) อีก 5 นาทีจะเริ่ม -> แจ้งเตือนเข้าทุกกลุ่ม LINE
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
  });
}
const db = admin.firestore();

const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function thaiDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]} ${d} ${MONTHS[m - 1]}`;
}

// ส่งข้อความเข้าทุกกลุ่ม คืนจำนวนกลุ่มที่ส่งสำเร็จ
async function pushAll(groupIds, text, errors) {
  let ok = 0;
  for (const gid of groupIds) {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ to: gid, messages: [{ type: 'text', text }] })
    });
    if (res.ok) {
      ok++;
    } else {
      const errText = await res.text();
      console.error('LINE push failed', gid, res.status, errText);
      errors.push(`${gid.slice(0, 8)}...: ${res.status} ${errText}`);
    }
  }
  return ok;
}

exports.handler = async () => {
  try {
    const configDoc = await db.collection('callScheduleApp').doc('config').get();
    const cfg = configDoc.exists ? configDoc.data() : {};
    const groupIds = [...new Set([...(cfg.groupIds || []), ...(cfg.groupId ? [cfg.groupId] : [])])];
    if (groupIds.length === 0) {
      return { statusCode: 200, body: 'ยังไม่มี Group ID (เชิญบอทเข้ากลุ่มแล้วพิมพ์ข้อความในกลุ่มก่อน)' };
    }

    const scheduleDoc = await db.collection('callScheduleApp').doc('call-schedule').get();
    if (!scheduleDoc.exists) {
      return { statusCode: 200, body: 'ยังไม่มีตารางนัด' };
    }
    const calls = JSON.parse(scheduleDoc.data().data || '[]');

    const now = new Date();
    const in5min = new Date(now.getTime() + 5 * 60000);
    let newCount = 0;
    let remindCount = 0;
    const errors = [];

    for (const c of calls) {
      if (!c.id || !c.date || !c.time) continue;

      // +07:00 = เวลาไทย (เซิร์ฟเวอร์ Netlify ใช้ UTC)
      const start = new Date(`${c.date}T${c.time}:00+07:00`);
      const end = c.timeEnd
        ? new Date(`${c.date}T${c.timeEnd}:00+07:00`)
        : new Date(start.getTime() + 60 * 60000);

      // ---- 1) นัดใหม่ / นัดที่ถูกแก้ ----
      const versionKey = [c.date, c.time, c.timeEnd || '', c.platform].join('|');
      const createdRef = db.collection('callScheduleApp_created').doc(c.id);
      const createdSnap = await createdRef.get();

      if (!createdSnap.exists || createdSnap.data().versionKey !== versionKey) {
        if (end <= now) {
          // นัดที่จบไปแล้ว: จดไว้เงียบๆ ไม่แจ้ง (กันสแปมนัดเก่า)
          await createdRef.set({ versionKey, notifiedAt: Date.now(), silent: true });
        } else {
          const isEdit = createdSnap.exists;
          const time = c.timeEnd ? `${c.time}–${c.timeEnd}` : c.time;
          const text =
            `${isEdit ? '✏️ แก้ไขนัด' : '📅 มีนัดใหม่'}\n` +
            `${c.platform}\n` +
            `${thaiDate(c.date)} เวลา ${time} น.` +
            (c.note ? `\n${c.note}` : '') +
            (c.link ? `\n${c.link}` : '');
          const okGroups = await pushAll(groupIds, text, errors);
          if (okGroups > 0) {
            await createdRef.set({ versionKey, notifiedAt: Date.now() });
            newCount++;
          }
        }
      }

      // ---- 2) อีก 5 นาทีจะเริ่ม ----
      if (start > now && start <= in5min) {
        const notifiedRef = db.collection('callScheduleApp_notified').doc(c.id);
        const notifiedSnap = await notifiedRef.get();
        if (notifiedSnap.exists) continue;

        const text = `⏰ อีก 5 นาทีจะเริ่มนัดคุยผ่าน ${c.platform} แล้วนะ!\n${c.date} เวลา ${c.time} น.${c.note ? '\n' + c.note : ''}`;
        const okGroups = await pushAll(groupIds, text, errors);
        if (okGroups > 0) {
          await notifiedRef.set({ notifiedAt: Date.now() });
          remindCount++;
        }
      }
    }

    const suffix = errors.length ? ` | errors: ${errors.join(' ; ')}` : '';
    const failedAll = errors.length > 0 && newCount + remindCount === 0;
    return {
      statusCode: failedAll ? 500 : 200,
      body: `checked, new ${newCount}, reminder ${remindCount} (groups: ${groupIds.length})${suffix}`
    };
  } catch (err) {
    console.error('check-notify error', err);
    return { statusCode: 500, body: 'error: ' + err.message };
  }
};
