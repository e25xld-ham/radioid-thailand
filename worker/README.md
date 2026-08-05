# Thai RadioID Downloader — Cloudflare Worker

Worker นี้เป็น server-side proxy สำหรับหน้าเว็บ Thai RadioID Downloader ทำหน้าที่:

- ดาวน์โหลด `https://radioid.net/static/user.csv` (พร้อม cache-busting query ใหม่ทุกครั้ง)
- ตรวจสอบความถูกต้องของ response (HTTP status, ไม่ใช่หน้า HTML error, ขนาดไฟล์ไม่ผิดปกติ)
- Parse CSV ด้วย state machine ที่รองรับ RFC 4180 (ไม่ใช้ `split(',')`)
- กรองเฉพาะ `RADIO_ID` ที่ขึ้นต้นด้วย `520` (ประเทศไทย)
- ลบรายการซ้ำ (คงรายการแรก) และเรียงลำดับจากน้อยไปมาก
- ส่งออกเป็น CSV ไฟล์เดียว พร้อม UTF-8 BOM (เปิดด้วย Excel ได้)
- แคชผลลัพธ์ชั่วคราวใน Cloudflare Cache API ไม่เกิน 5 นาที (ไม่ใช่ฐานข้อมูล)

Worker **ไม่มี** secret, token หรือฐานข้อมูลใด ๆ — ตัวแปรที่ config ได้มีเพียง `ALLOWED_ORIGIN`

## Endpoints

| Endpoint | คำอธิบาย | ดึงข้อมูลจาก RadioID.net? |
|---|---|---|
| `GET /api/status` | health check | ไม่ |
| `GET /api/fetch` | ดึง+กรองข้อมูลล่าสุด คืนค่าเป็น JSON summary | ใช่ (หรือใช้แคชถ้ายังไม่หมดอายุ) |
| `GET /api/download` | ดาวน์โหลด CSV รายชื่อไทยทั้งหมดเป็นไฟล์เดียว | ใช้แคชถ้ามี ไม่งั้น fetch ใหม่ |
| อื่น ๆ / method อื่น | — | ตอบ 404 / 405 |

## 1. ติดตั้ง Node.js

ต้องใช้ Node.js **18 ขึ้นไป** (แนะนำ 20 หรือใหม่กว่า) ดาวน์โหลดได้จาก [nodejs.org](https://nodejs.org/)

ตรวจสอบเวอร์ชัน:

```bash
node --version
```

## 2. ติดตั้ง Wrangler

รันจากโฟลเดอร์ `worker/` (ไม่ต้องติดตั้ง Wrangler แบบ global ก็ได้ ใช้ `npx wrangler` แทนได้เสมอ):

```bash
cd worker
npm install
```

คำสั่งนี้จะติดตั้ง Wrangler ตามที่ระบุใน `devDependencies` ของ `package.json`

## 3. Login เข้า Cloudflare

```bash
npx wrangler login
```

จะเปิดเบราว์เซอร์ให้ล็อกอินและอนุญาตสิทธิ์ Wrangler ตรวจสอบว่าล็อกอินสำเร็จด้วย:

```bash
npx wrangler whoami
```

## 4. คัดลอกไฟล์ config

```bash
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` อยู่ใน `.gitignore` แล้ว — จะไม่ถูก commit ขึ้น GitHub แก้ไขค่า `ALLOWED_ORIGIN` ในไฟล์นี้หากใช้ domain อื่นนอกจาก `https://e25xld-ham.github.io`

## 5. ทดสอบในเครื่อง (ไม่บังคับ)

```bash
npm run dev
```

จะรัน Worker ที่ `http://localhost:8787` — โค้ดฝั่ง frontend อนุญาต origin `localhost`/`127.0.0.1` ทุกพอร์ตให้โดยอัตโนมัติสำหรับการพัฒนา

## 6. Deploy Worker

```bash
npm run deploy
```

หรือ

```bash
npx wrangler deploy
```

เมื่อ deploy สำเร็จ Wrangler จะแสดง URL รูปแบบ:

```
https://radioid-thailand-api.<your-subdomain>.workers.dev
```

## 7. นำ URL ไปตั้งค่าในหน้าเว็บ

เปิดไฟล์ `assets/app.js` ที่ root ของโปรเจกต์ (**ไม่ใช่ในโฟลเดอร์ worker/**) แล้วแก้ไขค่าเดียวนี้:

```js
export const CONFIG = {
  API_BASE_URL: "https://radioid-thailand-api.<your-subdomain>.workers.dev",
};
```

จากนั้น commit และ push — GitHub Actions จะ deploy หน้าเว็บให้อัตโนมัติ

## ทดสอบด้วยตนเอง (manual)

```bash
curl https://radioid-thailand-api.<your-subdomain>.workers.dev/api/status

curl https://radioid-thailand-api.<your-subdomain>.workers.dev/api/fetch

curl -OJ https://radioid-thailand-api.<your-subdomain>.workers.dev/api/download
```

## รัน automated tests

```bash
npm test
```

ใช้ Node.js built-in test runner (`node --test`) ไม่ต้องติดตั้ง dependency เพิ่มเติม ครอบคลุม CSV parser, การกรอง 520, การลบข้อมูลซ้ำ, CORS, security headers, และ error handling เมื่อ upstream ล้มเหลว

## หมายเหตุด้านความปลอดภัย

- Worker fetch ได้เฉพาะ `radioid.net` เท่านั้น (hard-code ไว้ในโค้ด ไม่รับ URL จาก query parameter ใด ๆ) — ไม่ใช่ open proxy
- รองรับเฉพาะ method `GET` และ `OPTIONS` — method อื่นตอบ `405`
- จำกัด CORS origin ผ่าน `ALLOWED_ORIGIN`
- Timeout การ fetch upstream ประมาณ 35 วินาที และจำกัดขนาดไฟล์สูงสุด (ป้องกันไฟล์ผิดปกติ)
- log เฉพาะ เวลา, HTTP status, ขนาดไบต์ และจำนวนรายการ — **ไม่ log รายชื่อบุคคล**
- ถ้า upstream ล้มเหลว จะตอบกลับเป็น JSON error เท่านั้น จะไม่มีการสร้างไฟล์ CSV ว่างให้ดาวน์โหลด
