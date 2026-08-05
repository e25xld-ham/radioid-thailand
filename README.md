# Thai RadioID Downloader

เว็บไซต์สาธารณะสำหรับดาวน์โหลดรายชื่อ **DMR ID ประเทศไทย** (ขึ้นต้นด้วย `520`) ล่าสุดจาก [RadioID.net](https://radioid.net) เป็นไฟล์ CSV เดียว — ไม่มีการแบ่งไฟล์ ไม่มีฐานข้อมูล ไม่มีระบบ login และไม่เก็บรายชื่อไว้บนเว็บถาวร

> **สถานะ:** โค้ดทั้งหมด (frontend + Worker + tests) พร้อมใช้งานแล้ว ส่วนการ deploy จริงขึ้นอยู่กับสถานะที่รายงานไว้ท้ายงาน/ใน commit message — ดูหัวข้อ [Deploy Cloudflare Worker](#3-deploy-cloudflare-worker) และ [Deploy GitHub Pages](#2-deploy-github-pages) ก่อนใช้งานจริง

## สารบัญ

1. [วัตถุประสงค์](#วัตถุประสงค์)
2. [Architecture](#architecture)
3. [โครงสร้างโปรเจกต์](#โครงสร้างโปรเจกต์)
4. [Deploy GitHub Pages](#2-deploy-github-pages)
5. [Deploy Cloudflare Worker](#3-deploy-cloudflare-worker)
6. [วิธีเปลี่ยน Worker URL](#วิธีเปลี่ยน-worker-url)
7. [วิธีทดสอบ](#วิธีทดสอบ)
8. [นโยบายข้อมูลและความเป็นส่วนตัว](#นโยบายข้อมูลและความเป็นส่วนตัว)
9. [ข้อจำกัด](#ข้อจำกัด)
10. [แก้ปัญหา](#แก้ปัญหา)
11. [Attribution](#attribution)
12. [License](#license)

## วัตถุประสงค์

นักวิทยุสมัครเล่นและผู้ใช้งาน DMR ในประเทศไทยจำนวนมากต้องการรายชื่อ DMR ID ของไทยทั้งหมด (ที่ขึ้นต้นด้วยรหัสประเทศ `520`) เพื่อนำไปใช้กับวิทยุ/รหัสผู้ใช้งานของตนเอง แต่ไฟล์ `user.csv` ต้นฉบับจาก RadioID.net มีรายชื่อทั่วโลกขนาดใหญ่มาก โปรเจกต์นี้จึงสร้างหน้าเว็บให้ผู้ใช้กดปุ่มเดียว แล้วให้ Cloudflare Worker เป็นผู้ทำงานหนักแทน (ดาวน์โหลด, ตรวจสอบ, กรอง, สร้างไฟล์) และส่งเฉพาะรายชื่อไทยกลับมาเป็น CSV ไฟล์เดียวให้ดาวน์โหลด

## Architecture

```
Browser / GitHub Pages
        |
        |  ผู้ใช้กด "ดึงข้อมูลล่าสุด"
        v
Cloudflare Worker  (worker/src/index.js)
        |
        |  GET https://radioid.net/static/user.csv?v=<timestamp ใหม่ทุกครั้ง>
        |  cache: no-store, timeout ~35 วินาที
        v
RadioID.net
        |
        |  ตรวจสอบ HTTP status / ไม่ใช่หน้า HTML error / ขนาดไฟล์
        |  parse CSV แบบ RFC 4180 state machine
        |  กรองเฉพาะ RADIO_ID ที่ขึ้นต้นด้วย "520"
        |  ลบรายการซ้ำ + เรียงลำดับ + แคชชั่วคราว ≤ 5 นาที (Cache API)
        v
ส่ง JSON summary กลับไปหน้าเว็บ (จำนวนรายชื่อ, เวลา, ฯลฯ)
        |
        |  ผู้ใช้กด "ดาวน์โหลด CSV รายชื่อไทยทั้งหมด"
        v
Worker ส่งไฟล์ CSV เดียว (UTF-8 BOM, คอลัมน์เดิมครบ) กลับมาให้ดาวน์โหลด
```

**หลักการสำคัญ:** frontend (GitHub Pages) ไม่เคยติดต่อ RadioID.net โดยตรง — ทำผ่าน Cloudflare Worker เท่านั้น เพื่อแก้ปัญหา CORS และไม่ให้ browser ต้องดาวน์โหลดไฟล์ต้นฉบับขนาดใหญ่ทั้งหมด

Worker เป็นผู้ทำงานหนักทั้งหมด: ดาวน์โหลด CSV ต้นฉบับ, ตรวจสอบ response, parse CSV, กรองเฉพาะไทย, นับจำนวน, สร้างไฟล์ CSV สำหรับดาวน์โหลด, ตั้งค่า HTTP headers (CORS/security/download), และจัดการ timeout/error ทั้งหมด — frontend มีหน้าที่แค่เรียก API และแสดงผล

## โครงสร้างโปรเจกต์

```
radioid-thailand/
├── index.html                  # หน้าเว็บหลัก (ภาษาไทย)
├── assets/
│   ├── style.css                # ธีมวิทยุสมัครเล่น/DMR, responsive
│   └── app.js                   # ตรรกะฝั่ง frontend, CONFIG.API_BASE_URL
├── worker/
│   ├── src/index.js             # Cloudflare Worker (CSV parser + API)
│   ├── test/                    # node --test สำหรับ Worker
│   ├── wrangler.toml.example    # เทมเพลต config (ไม่มี secret)
│   ├── package.json
│   └── README.md                # คู่มือ deploy Worker แบบละเอียด
├── tests/
│   └── app.test.js              # node --test สำหรับ frontend
├── .github/workflows/
│   └── deploy-pages.yml         # deploy GitHub Pages อัตโนมัติ
├── .gitignore
├── LICENSE
└── README.md                    # ไฟล์นี้
```

## 1. ข้อกำหนดของ Cloudflare Worker API

| Endpoint | Method | หน้าที่ | แตะ RadioID.net? |
|---|---|---|---|
| `/api/status` | GET | ตรวจสอบว่า Worker พร้อมทำงาน | ไม่ |
| `/api/fetch` | GET | ดึง+กรองข้อมูลล่าสุด คืน JSON summary (จำนวนรายชื่อ, เวลา, ตัวอย่างสูงสุด 10 แถว) | ใช่ (หรือใช้แคช ≤ 5 นาที) |
| `/api/download` | GET | ส่งไฟล์ CSV รายชื่อไทยทั้งหมด **ไฟล์เดียว** | ใช้แคชถ้ามี ไม่งั้น fetch ใหม่ |

Method อื่นนอกจาก `GET`/`OPTIONS` จะได้รับ `405` ดูรายละเอียดเพิ่มเติมใน [`worker/README.md`](worker/README.md)

## 2. Deploy GitHub Pages

1. ไปที่ **Settings → Pages → Source** แล้วเลือก **GitHub Actions** (ไม่ใช่ "Deploy from a branch")
2. Push โค้ดไปที่ branch `main` — workflow `.github/workflows/deploy-pages.yml` จะรันอัตโนมัติและ deploy เฉพาะ `index.html` และ `assets/` เท่านั้น (โฟลเดอร์ `worker/` จะไม่ถูกนำขึ้น Pages)
3. สามารถสั่งรันเองได้ผ่านแท็บ **Actions → Deploy GitHub Pages → Run workflow** (`workflow_dispatch`)
4. หลัง deploy สำเร็จ เว็บไซต์จะอยู่ที่ `https://e25xld-ham.github.io/radioid-thailand/`

Workflow ใช้สิทธิ์ขั้นต่ำเท่านั้น (`contents: read`, `pages: write`, `id-token: write`) และใช้ official actions (`configure-pages`, `upload-pages-artifact`, `deploy-pages`)

## 3. Deploy Cloudflare Worker

ดูคู่มือแบบละเอียดทีละขั้นตอนที่ [`worker/README.md`](worker/README.md) สรุปสั้น ๆ:

```bash
cd worker
npm install                      # ติดตั้ง Wrangler
npx wrangler login                # login เข้า Cloudflare (เปิดเบราว์เซอร์)
npx wrangler whoami                # ตรวจสอบว่า login สำเร็จ
cp wrangler.toml.example wrangler.toml
npx wrangler deploy                # deploy ขึ้น *.workers.dev
```

Deploy สำเร็จแล้วจะได้ URL รูปแบบ `https://radioid-thailand-api.<subdomain>.workers.dev` — นำไปตั้งค่าตามหัวข้อถัดไป

`wrangler.toml` อยู่ใน `.gitignore` และ**ไม่ถูก commit** ขึ้น GitHub — ไฟล์ที่ commit มีเพียง `wrangler.toml.example` ซึ่งไม่มี `account_id` หรือ token ใด ๆ

## วิธีเปลี่ยน Worker URL

Worker URL ถูกประกาศไว้ **จุดเดียว** ในโปรเจกต์ทั้งหมด คือไฟล์ [`assets/app.js`](assets/app.js):

```js
export const CONFIG = {
  API_BASE_URL: "https://REPLACE-WITH-WORKER.workers.dev",
};
```

แก้ค่านี้เป็น URL จริงหลัง deploy Worker แล้ว commit + push — GitHub Actions จะ deploy หน้าเว็บใหม่ให้อัตโนมัติ ไม่ต้องแก้ไขไฟล์อื่นใดอีก

## วิธีทดสอบ

**Worker (CSV parser, การกรอง 520, dedupe, CORS, error handling):**

```bash
cd worker
npm install
npm test
```

**Frontend (page load ไม่เรียก /api/fetch, ปุ่มดาวน์โหลด disabled จนกว่าจะ fetch สำเร็จ, ฟังก์ชัน format ต่าง ๆ):**

```bash
npm test
```

(รันจาก root ของโปรเจกต์ — ไม่ต้อง `npm install` เพิ่มเติมเพราะใช้ Node.js built-in test runner ล้วน ๆ)

**ทดสอบ Worker แบบ manual หลัง deploy จริง:**

```bash
curl https://<your-worker>.workers.dev/api/status
curl https://<your-worker>.workers.dev/api/fetch
curl -OJ https://<your-worker>.workers.dev/api/download
```

**ทดสอบหน้าเว็บจริง:** เปิด GitHub Pages URL → กด "ดึงข้อมูลล่าสุด" → รอจนแสดงจำนวนรายชื่อ → กด "ดาวน์โหลด CSV รายชื่อไทยทั้งหมด" → เปิดไฟล์ด้วย Excel ตรวจสอบว่าอักษรไทยแสดงถูกต้อง (ไม่เพี้ยน) และมีเพียงไฟล์เดียว ไม่มีการแบ่งไฟล์

## นโยบายข้อมูลและความเป็นส่วนตัว

- **ดึงข้อมูลเมื่อผู้ใช้กดปุ่มเท่านั้น** — หน้าเว็บจะเรียก `/api/status` ตอนโหลดหน้าเพื่อตรวจสอบว่า Worker พร้อมใช้งานเท่านั้น **จะไม่เรียก `/api/fetch` หรือดาวน์โหลดข้อมูลจาก RadioID.net โดยอัตโนมัติ** จนกว่าผู้ใช้จะกดปุ่ม "ดึงข้อมูลล่าสุด" ด้วยตนเอง
- **ไม่มีการเก็บรายชื่อไว้ถาวร** — โปรเจกต์นี้ไม่มีฐานข้อมูลใด ๆ ทั้งฝั่ง Worker และฝั่งเว็บ ไฟล์ `user.csv` ต้นฉบับจะไม่ถูก commit ขึ้น GitHub (มีการป้องกันด้วย `.gitignore`) ผลลัพธ์ที่กรองแล้วจะถูกเก็บไว้ชั่วคราวใน Cloudflare Cache API (edge cache) **ไม่เกิน 5 นาที** เพื่อลดจำนวนครั้งที่ต้องดึงข้อมูลซ้ำจาก RadioID.net เท่านั้น ไม่ใช่การจัดเก็บถาวร
- **ไม่มีระบบ login และไม่เก็บข้อมูลส่วนตัวของผู้ใช้งานเว็บไซต์** — Worker log เฉพาะ เวลา, HTTP status, ขนาดไฟล์ (ไบต์) และจำนวนรายการที่พบเท่านั้น จะไม่ log รายชื่อบุคคลใด ๆ ลง console

## ข้อจำกัด

- ข้อมูลที่แสดงคือข้อมูล ณ เวลาที่กดปุ่ม "ดึงข้อมูลล่าสุด" เท่านั้น หากมีผู้ใช้กดซ้ำภายใน 5 นาที Worker จะส่งข้อมูลจากแคชแทนการดึงใหม่
- ฟิลด์ `sourceUpdatedAt` อาจเป็น `null` ได้ หาก RadioID.net ไม่ส่ง header `Last-Modified` กลับมา
- ไฟล์ `user.csv` ต้นฉบับมีขนาดค่อนข้างใหญ่ (รายชื่อทั่วโลก) — Worker จำกัดขนาดไฟล์สูงสุดที่ยอมรับไว้เพื่อป้องกันการใช้ทรัพยากรผิดปกติ หากไฟล์ต้นฉบับใหญ่ผิดปกติจริง ๆ อาจต้องพิจารณาอัปเกรดแผน Cloudflare Workers (Unbound usage model) เพื่อรองรับ CPU time ที่มากขึ้น
- Worker นี้พึ่งพาโครงสร้างคอลัมน์ CSV ของ RadioID.net (โดยเฉพาะคอลัมน์ `RADIO_ID`) หาก RadioID.net เปลี่ยนโครงสร้างไฟล์อย่างมีนัยสำคัญ อาจต้องปรับโค้ด parser
- **ผู้ดูแลเว็บไซต์ควรตรวจสอบ API/Data Use Policy ของ RadioID.net ก่อนเปิดให้บริการสาธารณะ** เพื่อให้แน่ใจว่าการดึงข้อมูลอัตโนมัติผ่าน Worker เป็นไปตามเงื่อนไขการใช้งานของ RadioID.net ในขณะนั้น

## แก้ปัญหา

### CORS error ("has been blocked by CORS policy")

1. ตรวจสอบว่าตั้งค่า `ALLOWED_ORIGIN` ใน `worker/wrangler.toml` ตรงกับ origin จริงของหน้าเว็บ (เช่น `https://e25xld-ham.github.io`) — ไม่ใส่ path หรือ trailing slash
2. หลังแก้ `wrangler.toml` ต้อง deploy ใหม่ (`npx wrangler deploy`) การแก้ไฟล์เฉย ๆ ไม่มีผลจนกว่าจะ deploy
3. ถ้าทดสอบจาก `localhost` ระบบอนุญาตให้อัตโนมัติอยู่แล้วโดยไม่ต้องแก้ `ALLOWED_ORIGIN`
4. ถ้าใช้ custom domain ให้เพิ่มเข้าไปใน `ALLOWED_ORIGIN` แบบคั่นด้วยจุลภาค (ดูตัวอย่างใน `wrangler.toml.example`)

### RadioID.net ดาวน์โหลดไม่ได้ / กดปุ่มแล้ว error

Worker จะแปลข้อผิดพลาดเป็นข้อความภาษาไทยที่หน้าเว็บให้อัตโนมัติ สาเหตุที่เป็นไปได้:

- RadioID.net ล่มชั่วคราวหรือตอบกลับ HTTP status ที่ไม่ใช่ 200 — ลองใหม่อีกครั้งภายหลัง (ปุ่ม "ลองใหม่อีกครั้ง" บนหน้าเว็บ)
- การเชื่อมต่อหมดเวลา (timeout ~35 วินาที) — เครือข่ายช้าหรือ RadioID.net ตอบช้าผิดปกติ
- RadioID.net ส่งหน้า HTML error กลับมาแทนไฟล์ CSV (เช่น หน้า maintenance) — Worker ตรวจจับกรณีนี้และไม่นำไปประมวลผลต่อ
- ไฟล์ต้นฉบับใหญ่ผิดปกติเกินเพดานที่กำหนดไว้ — ป้องกัน Worker ใช้ทรัพยากรเกินควร

ในทุกกรณีข้างต้น ระบบ**จะไม่สร้างไฟล์ CSV ว่างให้ดาวน์โหลด** — ผู้ใช้จะเห็นข้อความ error แทน

### ปุ่ม "ดาวน์โหลด CSV" กดไม่ได้ (จาง/disabled)

เป็นพฤติกรรมที่ตั้งใจ — ปุ่มดาวน์โหลดจะถูก disabled จนกว่าจะกด "ดึงข้อมูลล่าสุด" และได้รับผลลัพธ์สำเร็จก่อนเสมอ

## Attribution

ข้อมูลต้นทางจาก [RadioID.net](https://radioid.net) — เว็บไซต์นี้**ไม่ใช่**บริการอย่างเป็นทางการของ RadioID.net เป็นเพียงเครื่องมือช่วยกรองข้อมูลที่เปิดเผยต่อสาธารณะ (public CSV) ให้ใช้งานง่ายขึ้นสำหรับนักวิทยุสมัครเล่นในประเทศไทยเท่านั้น

## License

[MIT](LICENSE)
