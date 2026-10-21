# Scratch Card Event Game — WMMT-1663

เกมขูดบัตรลุ้นรางวัลสำหรับบูธ (4 วัน / จำกัด 50 รางวัลต่อวัน)

## User Flow

| # | ขั้นตอน | หน้าจอ |
|---|---|---|
| 1 | ผู้ร่วมงานสแกน QR ที่บูธ | ป้าย `/poster` (พิมพ์ A4) |
| 2 | เข้าเกมผ่าน Web | `/` — ไม่ต้อง login (ถ้าตั้ง LIFF แล้วเปิดใน LINE จะใช้ LINE ID แทน) |
| 3 | กรอกข้อมูล Lead: ชื่อ / บริษัท / เบอร์โทร | หน้าแรก (step bar ขั้น 1) |
| 4 | ขูดบัตรบนหน้าจอ → ค่อยๆ เผยรางวัล | step bar ขั้น 2 |
| 5 | แสดงผลรางวัล + โค้ด/QR สำหรับยื่นให้ Staff | step bar ขั้น 3 |
| 6 | Staff กดยืนยัน "รับรางวัลแล้ว" | ปุ่มบนจอผู้เล่น + กรอกชื่อ Staff — หรือสแกน QR ไปหน้า `/staff` (ใช้ PIN) |
| 7 | End state: บันทึกผลลงระบบ | จอผู้เล่นขึ้น "รับรางวัลเรียบร้อย · บันทึกผลลงระบบแล้ว" + เวลา, ข้อมูลอยู่ใน Backoffice/CSV |

| หน้า | URL | ใช้โดย |
|---|---|---|
| ป้าย QR หน้าบูธ | `/poster` | พิมพ์ติดบูธ |
| เกม | `/` | ผู้ร่วมงาน |
| Staff ยืนยันรับรางวัล | `/staff` | Staff ที่บูธ (PIN) |
| Backoffice | `/admin` | ทีม Event / Marketing (ชื่อผู้ใช้ + รหัสผ่าน จาก `ADMIN_USERNAME` / `ADMIN_PASSWORD`) |

**กันเล่นซ้ำ (Web):** 1 เบราว์เซอร์ = 1 สิทธิ์ และ 1 เบอร์โทร = 1 สิทธิ์ (ล้างเบราว์เซอร์แล้วใช้เบอร์เดิมเล่นซ้ำไม่ได้)

**ยินยอมให้ติดต่อกลับ:** ไม่บังคับ — ระบบเก็บว่าผู้เล่นยินยอมหรือไม่ แสดงในหน้า "ผู้เล่น" และคอลัมน์ใน CSV

**ยืนยันรับรางวัลบนจอผู้เล่น:** Staff กรอกชื่อตัวเอง (ไม่ใช้ PIN ตามที่ทีมขอ) — ผู้เล่นกดยืนยันเองได้ถ้าตั้งใจ จึงควรให้ Staff เป็นคนกดเสมอ · หน้า `/staff` ยังใช้ PIN (ใส่ผิด 8 ครั้ง ล็อก 5 นาที)

## Run

```bash
npm install
cp .env.example .env   # แล้วตั้ง ADMIN_USERNAME / ADMIN_PASSWORD / STAFF_PIN
npm run dev            # http://localhost:3000
npm test               # ทดสอบ concurrency 200 คนพร้อมกัน, กันเล่นซ้ำ, เวลาเปิด-ปิด, redeem ซ้ำ ฯลฯ
```

ต้องใช้ Node.js 22 · ฐานข้อมูล: ถ้าตั้ง `DATABASE_URL` → Postgres (Supabase) · ถ้าไม่ตั้ง → SQLite ในเครื่อง (`data/event.db`)

## Deploy: Supabase + Vercel

1. **Supabase** → New project (Region: Singapore) แล้วใส่ใน `.env`:
   - `DATABASE_URL` = Connect → **Transaction pooler** (port 6543) + รหัสผ่าน DB
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` = Project Settings → API
2. `npm run db:setup` — สร้างตาราง + เปิด Row Level Security ทุกตาราง + ใส่ข้อมูลเริ่มต้น + สร้าง bucket `prizes` (รันซ้ำได้ ไม่ทับข้อมูล)
3. **Vercel** → Import repo (Framework: Other) → Environment Variables: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `STAFF_PIN`, `PUBLIC_URL` (= โดเมน Vercel), `WEB_PLAY=1` → Deploy
   - `vercel.json`: หน้าเว็บจาก `public/`, API ทั้งหมดผ่าน `api/index.js`, region `sin1` (ใกล้ Supabase Singapore)

ทดสอบกับ Postgres ในเครื่อง: `TEST_DATABASE_URL=postgres://… node --test --test-concurrency=1 test/*.test.js`
(ลบและสร้างตารางใหม่ทุกเทสต์ — ใช้ฐานข้อมูลทดสอบเท่านั้น)

`WEB_PLAY=1` (ค่าเริ่มต้น) = เล่นผ่านเว็บได้เลยตาม User Flow · `WEB_PLAY=0` = บังคับ LINE (LIFF) เท่านั้น

## Stack (เลือกไว้ระหว่างรอ Dev Team ยืนยัน)

- **Backend**: Node.js + Express 5 · Postgres/Supabase (production) หรือ SQLite (`node:sqlite`, ในเครื่อง)
- **รูปรางวัล**: Supabase Storage (bucket `prizes`) หรือ `data/uploads/` ในเครื่อง
- **Front-end**: HTML/CSS/JS ล้วน ไม่มี build step (`public/`)
- **LINE (optional)**: ถ้าตั้ง LIFF แล้วเปิดใน LINE → ใช้ LINE ID + ตรวจ ID token ฝั่ง server, Messaging API push ผลรางวัล

## Prize logic

- Backoffice → **รางวัล**: ตั้งจำนวนแต่ละรางวัลต่อวัน (เพิ่ม/ลบ/แก้ชื่อรางวัลได้) · ผู้ได้รางวัลต่อวัน = ผลรวมของวันนั้น
- ระบบสุ่มลำดับให้เอง: ผู้เล่นคนที่ **N** ของวัน (เวลาไทย) ได้รางวัลใน Slot N · ช่องที่แจกไปแล้วไม่ถูกเปลี่ยน
- Backoffice → **วันและเวลา**: เลือกช่วงวันจากปฏิทิน (แบบจองที่พัก) + เวลาเปิด-ปิดเดียวกันทุกวัน
- การจองลำดับเป็น transaction เดียว (SQLite: `BEGIN IMMEDIATE` · Postgres: advisory lock ต่อการจับรางวัล) + unique constraint `(day_no, slot_no)` และ `(line_user_id, day_no)` → ไม่มีทางเกินจำนวน / ไม่มีทางได้ Slot ซ้ำ แม้กดพร้อมกันจากหลายเซิร์ฟเวอร์ (ทดสอบ 300 คน × 2 instance บน Postgres แล้ว)
- ผล **ถูกบันทึกตอนกดเริ่ม** (ก่อนขูด) → รีเฟรชหน้าไม่ทำให้สุ่มใหม่ได้ ถ้ายังขูดไม่เสร็จจะกลับมาที่หน้าขูดเดิม
- ไม่แสดงเลขลำดับให้ผู้เล่นเห็น (ลดการคาดเดารางวัล — Gap #4)
- ทุกคนที่ได้รางวัลได้ **โปรโมชัน 1 สิทธิ์แบบสุ่ม** (ตัวเลือก A ใน card)
- โควตาเต็ม → หน้า "รางวัลวันนี้หมดแล้ว" + รายการโปรโมชันทั้งหมด (ไม่เสียสิทธิ์ เล่นวันถัดไปได้)
- ตั้งจำนวนรางวัลน้อยกว่าที่แจกไปแล้ว/ลบรางวัลที่มีคนได้ไปแล้ว/ย้ายวันที่มีผู้เล่นแล้ว — ระบบไม่ยอม

## การตัดสินใจที่ยังรอยืนยัน (Gaps & Risks ใน card)

| # | ประเด็น | ค่าที่ใช้ตอนนี้ | ปรับได้ที่ |
|---|---|---|---|
| 1 | การ์ดมูนนับรวมใน 50 คนหรือไม่ | นับรวม (50 คน = รวมการ์ดมูน) | Backoffice → รางวัล |
| 2 | คนที่ 51+ ได้อะไร | หน้า "หมดแล้ว" + แสดงโปรโมชัน, ไม่บันทึกเป็นการเล่น | โค้ด `game.play()` |
| 3 | สิทธิ์เล่น 1 ครั้ง/งาน หรือ /วัน | 1 ครั้งตลอดงาน (ต่อเบราว์เซอร์ + ต่อเบอร์โทร) | Backoffice → ตั้งค่า |
| 5 | สัญญาณเน็ตในงาน | หน้าเกมเบามาก (ไม่มี framework) แต่ยังต้องมีเน็ต — ควรเตรียม Hotspot | — |
| 6 | Design Asset (KV, น้องสุกี้) | ไอคอนรางวัลวาดเป็น SVG (`public/img/prizes/`) + สี placeholder (`public/css/game.css` `:root`) | รอ Marketing — วางไฟล์ทับชื่อเดิมได้เลย |
| — | วันจัดงาน | Day 1 = วันที่รัน server ครั้งแรก, 4 วัน, 09:00–18:00 | Backoffice → วันและเวลา |

## Production checklist

- [ ] ตั้ง `ADMIN_USERNAME` / `ADMIN_PASSWORD` (อย่าใช้ 123456 ตอนงานจริง), `STAFF_PIN` ใหม่, `PUBLIC_URL` (QR บนป้ายใช้ค่านี้) แล้วพิมพ์ป้ายจาก `/poster`
- [ ] (Optional) สร้าง LIFF app (Size: Full, Scope: `openid profile`) → ตั้ง `LIFF_ID`, `LINE_LOGIN_CHANNEL_ID`
- [ ] (Optional) `LINE_CHANNEL_ACCESS_TOKEN` ของ OA เพื่อ push ผลรางวัล
- [ ] Production ใช้ Supabase + Vercel (ดูหัวข้อ Deploy) — ถ้าใช้ SQLite ต้องมี disk ถาวรและรัน instance เดียว
- [ ] ตั้งช่วงวันจัดงานจริง + ตรวจจำนวนรางวัลทุกวันใน Backoffice
- [ ] ลบ `data/event.db` ที่ใช้ทดสอบก่อนวันงาน
- [ ] ทดสอบบน iOS / Android ผ่าน LINE in-app browser
